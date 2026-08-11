/**
 * cloudinaryService.js
 *
 * Hébergement des photos de profil (patients, médecins, admins, superadmins).
 *
 * L'application mobile envoie l'image en base64 au backend, qui la téléverse
 * chez Cloudinary et ne garde en base que l'URL. Ce détour par le serveur est
 * volontaire : un upload direct depuis le téléphone imposerait soit d'exposer
 * un preset non signé (n'importe qui pourrait alors remplir le compte), soit
 * d'embarquer l'API secret dans le bundle, d'où il serait extractible.
 *
 * Les affiches de pharmacies de garde, elles, restent uploadées par n8n : la
 * source y est déjà une URL distante, pas un fichier choisi par un utilisateur.
 *
 * Variables d'environnement (déjà présentes pour le pipeline n8n) :
 *   - CLOUDINARY_CLOUD_NAME
 *   - CLOUDINARY_API_KEY
 *   - CLOUDINARY_API_SECRET
 *   - CLOUDINARY_DOSSIER_PHOTOS (optionnel) dossier de destination.
 */
const crypto = require('crypto');

const DOSSIER_DEFAUT = 'mediora/photos-profil';

/**
 * Taille maximale de l'image reçue. L'app redimensionne déjà avant l'envoi :
 * au-delà, c'est un client qui contourne cette étape, et une image de plusieurs
 * mégaoctets pour un avatar de 44 px n'a aucun intérêt.
 */
const TAILLE_MAX_OCTETS = 5 * 1024 * 1024;

/**
 * Transformation appliquée à l'arrivée (donc avant stockage) : l'original n'est
 * jamais conservé, ce qui borne à la fois le quota Cloudinary et le temps de
 * chargement des listes d'utilisateurs.
 */
const TRANSFORMATION = 'c_limit,w_512,h_512,q_auto:good';

const FORMATS_ACCEPTES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];

/** Lit la configuration, en levant une erreur explicite si elle est incomplète. */
function configuration() {
    const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
    const apiKey = (process.env.CLOUDINARY_API_KEY || '').trim();
    const apiSecret = (process.env.CLOUDINARY_API_SECRET || '').trim();

    if (!cloudName || !apiKey || !apiSecret) {
        const err = new Error(
            "Configuration Cloudinary incomplète (CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET) : "
            + "l'envoi de photo de profil est indisponible."
        );
        err.status = 503;
        throw err;
    }
    return { cloudName, apiKey, apiSecret };
}

/**
 * Signature d'un upload Cloudinary : SHA-1 des paramètres triés par ordre
 * alphabétique, concaténés en `cle=valeur&…`, suivis de l'API secret.
 * `file`, `api_key` et `resource_type` en sont exclus par l'API.
 */
function signer(params, apiSecret) {
    const aSigner = Object.keys(params)
        .sort()
        .map((cle) => `${cle}=${params[cle]}`)
        .join('&');
    return crypto.createHash('sha1').update(aSigner + apiSecret).digest('hex');
}

/**
 * Découpe une data URI `data:image/jpeg;base64,…` en { mimeType, octets }.
 * Renvoie null si la chaîne n'en est pas une.
 */
function lireDataUri(valeur) {
    const correspondance = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(String(valeur || '').trim());
    if (!correspondance) return null;
    return {
        mimeType: correspondance[1].toLowerCase(),
        // Longueur en octets déduite du base64, sans allouer le Buffer : inutile
        // de décoder 5 Mo pour découvrir ensuite qu'on va les refuser.
        octets: Math.floor((correspondance[2].length * 3) / 4),
    };
}

/**
 * Téléverse une photo de profil et renvoie son URL HTTPS.
 *
 * @param {string} donnee    data URI base64 (`data:image/jpeg;base64,…`).
 * @param {string} reference identifiant stable (l'uid) : la nouvelle photo
 *                           écrase l'ancienne au lieu de s'y ajouter, ce qui
 *                           évite d'accumuler des images orphelines à chaque
 *                           changement d'avatar.
 */
async function televerserPhotoProfil(donnee, reference) {
    const { cloudName, apiKey, apiSecret } = configuration();

    const image = lireDataUri(donnee);
    if (!image) {
        const err = new Error("Photo invalide : une image encodée en base64 est attendue.");
        err.status = 400;
        throw err;
    }
    if (!FORMATS_ACCEPTES.includes(image.mimeType)) {
        const err = new Error(`Format d'image non supporté (${image.mimeType}). Utilisez JPEG, PNG ou WebP.`);
        err.status = 400;
        throw err;
    }
    if (image.octets > TAILLE_MAX_OCTETS) {
        const err = new Error(
            `Photo trop lourde (${Math.round(image.octets / 1024 / 1024)} Mo). Maximum ${TAILLE_MAX_OCTETS / 1024 / 1024} Mo.`
        );
        err.status = 413;
        throw err;
    }

    const parametres = {
        folder: (process.env.CLOUDINARY_DOSSIER_PHOTOS || DOSSIER_DEFAUT).trim(),
        // `invalidate` purge le CDN : sans lui, l'ancienne photo resterait
        // servie pendant des heures sur l'URL réécrite.
        invalidate: 'true',
        overwrite: 'true',
        public_id: `profil-${reference}`,
        timestamp: Math.floor(Date.now() / 1000),
        transformation: TRANSFORMATION,
    };

    const corps = new URLSearchParams({
        ...parametres,
        file: donnee,
        api_key: apiKey,
        signature: signer(parametres, apiSecret),
    });

    let reponse;
    try {
        reponse = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: corps,
        });
    } catch (error) {
        const err = new Error(`Cloudinary injoignable : ${error.message}`);
        err.status = 502;
        throw err;
    }

    if (!reponse.ok) {
        const detail = await reponse.text().catch(() => '');
        console.error(`❌ Upload Cloudinary ${reponse.status} :`, detail.slice(0, 300));
        const err = new Error("L'envoi de la photo a échoué. Réessayez.");
        err.status = 502;
        throw err;
    }

    const json = await reponse.json();
    if (!json.secure_url) {
        const err = new Error("Réponse Cloudinary inattendue : URL absente.");
        err.status = 502;
        throw err;
    }
    return json.secure_url;
}

/**
 * Résout le champ `photo` reçu d'un client en une URL stockable.
 *
 * Trois cas, pour que les écrans n'aient pas à distinguer « créer », « garder »
 * et « supprimer » :
 *   - data URI base64  → upload, renvoie l'URL Cloudinary ;
 *   - URL http(s)      → déjà hébergée (photo Google, photo inchangée) ;
 *   - chaîne vide/null → suppression explicite, renvoie ''.
 * `undefined` renvoie `undefined` : le champ n'a pas été touché.
 */
async function resoudrePhoto(photo, reference) {
    if (photo === undefined) return undefined;
    if (photo === null) return '';

    const valeur = String(photo).trim();
    if (!valeur) return '';
    if (/^https?:\/\//i.test(valeur)) return valeur;

    return televerserPhotoProfil(valeur, reference);
}

module.exports = { televerserPhotoProfil, resoudrePhoto, TAILLE_MAX_OCTETS };