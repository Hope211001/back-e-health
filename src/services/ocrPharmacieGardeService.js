/**
 * ocrPharmacieGardeService.js
 *
 * Lecture des affiches de pharmacies de garde par un modèle vision, via
 * OpenRouter. Reprend le traitement qui tournait auparavant dans le workflow
 * n8n « ocr-pharmacie-garde », désormais dans le dépôt et versionné.
 *
 * Déroulé, pour une publication :
 *   1. ses images (champ `attachement`) sont lues UNE PAR UNE, jamais en
 *      parallèle : les modèles `:free` d'OpenRouter ont une limite de requêtes
 *      par minute basse, et une rafale ferait échouer tout le lot ;
 *   2. chaque réponse est un JSON { pharmacies: [...] } — extrait avec
 *      tolérance, les modèles l'enrobant parfois de markdown ;
 *   3. les résultats des images sont fusionnés, dédoublonnés, puis regroupés
 *      par ville dans leur ordre d'apparition sur l'affiche.
 *
 * Une image illisible n'interrompt pas les autres : l'échec est consigné dans
 * `erreurs` et rendu visible dans l'application. Une affiche partiellement lue
 * vaut mieux qu'un écran d'erreur.
 *
 * Variables d'environnement : voir openRouterService.js, plus
 *   - OCR_MAX_IMAGES       (optionnel) images analysées au plus par publication
 *   - OCR_PROMPT           (optionnel) prompt en une seule variable
 *   - OCR_PROMPT_FILE      (optionnel) chemin d'un autre fichier de prompt
 */
const fs = require('fs');
const path = require('path');
const { appelerModele, extraireJson, modelesVision } = require('./openRouterService');

/**
 * Nombre d'images traitées au maximum pour une publication. Une publication
 * Facebook porte parfois une dizaine de photos dont seules les premières sont
 * l'affiche : les suivantes coûteraient du quota sans rien apporter.
 */
const MAX_IMAGES_DEFAUT = 5;

/**
 * Pause entre deux images. Le palier gratuit d'OpenRouter autorise 20 requêtes
 * par minute : une toutes les 3,5 s laisse de la marge pour les réessais.
 */
const PAUSE_ENTRE_IMAGES_MS = 3500;

/**
 * Attente avant de reprendre les images perdues (voir la seconde passe plus
 * bas). Assez longue pour que le pool partagé du modèle se soit libéré.
 */
const PAUSE_SECONDE_PASSE_MS = 30000;

const FICHIER_PROMPT_DEFAUT = path.join(__dirname, '..', 'prompts', 'ocr-pharmacie-garde.txt');

/**
 * Dernier recours si la variable d'env est vide ET le fichier illisible : le
 * service doit rester fonctionnel même si quelqu'un supprime le .txt.
 */
const PROMPT_SECOURS = `Tu es un OCR d'affiches de pharmacies de garde.
Réponds UNIQUEMENT par un JSON valide de la forme :
{"pharmacies":[{"ville":"","nom":"","adresse":"","telephones":[]}]}
N'invente jamais de valeur : laisse vide ce qui est illisible.`;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Prompt effectif, par ordre de priorité : variable d'env, puis fichier, puis
 * secours.
 *
 * Relu à chaque publication et non mis en cache : éditer le .txt prend effet à
 * l'analyse suivante, sans redémarrer le serveur. Le coût est une lecture
 * disque de quelques kilo-octets, négligeable devant l'appel réseau au modèle.
 */
function chargerPrompt() {
    const depuisEnv = (process.env.OCR_PROMPT || '').trim();
    if (depuisEnv) return depuisEnv;

    const fichier = process.env.OCR_PROMPT_FILE
        ? path.resolve(process.cwd(), process.env.OCR_PROMPT_FILE)
        : FICHIER_PROMPT_DEFAUT;

    try {
        // Tout ce qui suit une ligne de tirets seuls est une note pour le
        // développeur, pas une consigne pour le modèle.
        const contenu = fs.readFileSync(fichier, 'utf8').split(/^---\s*$/m)[0].trim();
        if (contenu) return contenu;
        console.warn(`⚠️  Prompt OCR vide (${fichier}) — utilisation du prompt de secours.`);
    } catch (error) {
        console.warn(`⚠️  Prompt OCR illisible (${fichier}) : ${error.message} — prompt de secours.`);
    }
    return PROMPT_SECOURS;
}

/**
 * Normalise les pharmacies renvoyées pour une image.
 *
 * Le modèle oublie parfois de répéter la ville sur chaque ligne d'un bloc :
 * sur l'affiche, le titre n'est écrit qu'une fois en tête de colonne. On
 * reprend alors la dernière ville rencontrée, comme le ferait un lecteur — sans
 * ça, toutes les pharmacies sauf la première de chaque bloc se retrouvent sans
 * ville et deviennent inutilisables dans la liste.
 */
function normaliserPharmacies(brutes) {
    let villeCourante = '';

    return (Array.isArray(brutes) ? brutes : [])
        .map((p) => {
            if (!p || typeof p !== 'object') return null;

            const ville = String(p.ville || '').trim();
            if (ville) villeCourante = ville;

            const nom = String(p.nom || '').trim();
            const telephones = Array.isArray(p.telephones)
                ? p.telephones.map((t) => String(t).trim()).filter(Boolean)
                : [];

            // Une entrée sans nom ni téléphone n'apporte rien.
            if (!nom && telephones.length === 0) return null;

            return {
                ville: ville || villeCourante,
                nom,
                adresse: String(p.adresse || '').trim(),
                telephones,
            };
        })
        .filter(Boolean);
}

/**
 * Lit une image et renvoie { pharmacies, modeleUtilise, erreur }.
 *
 * Ne lève pas sur un échec de lecture : `erreur` porte alors le message, pour
 * que la publication garde les pharmacies extraites de ses autres images.
 */
async function lireImage(imageUrl, modeles, prompt) {
    const { contenu, modeleUtilise, tronque, erreur } = await appelerModele({
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: imageUrl } },
                ],
            },
        ],
        modeles,
    });

    if (erreur) return { pharmacies: [], modeleUtilise, erreur };

    const parse = extraireJson(contenu);
    if (!parse) {
        return {
            pharmacies: [],
            modeleUtilise,
            erreur: 'Réponse du modèle illisible (JSON attendu).',
        };
    }

    const pharmacies = normaliserPharmacies(parse.pharmacies);

    return {
        pharmacies,
        modeleUtilise,
        // Tronqué = l'affiche contient plus de pharmacies que le plafond de
        // tokens n'en laisse écrire. On garde ce qui a été lu, mais on le dit :
        // une liste incomplète présentée comme complète est pire qu'une erreur.
        erreur: tronque
            ? "Affiche trop longue : la lecture a été coupée, toutes les pharmacies n'y sont pas."
            : null,
    };
}

/**
 * Lance l'OCR sur toutes les images d'une publication et fusionne les résultats.
 *
 * @param  {string[]} imageUrls  URLs des affiches (champ `attachement`).
 * @return {{ modele, images, pharmacies, texteBrut, nbVilles, erreurs }}
 */
async function lirePublication(imageUrls) {
    const modeles = modelesVision();
    // Chargé une fois par publication : toutes ses images sont lues avec le
    // même prompt, même si le fichier est édité entre deux images.
    const prompt = chargerPrompt();
    const maxImages = Number(process.env.OCR_MAX_IMAGES) || MAX_IMAGES_DEFAUT;

    const images = (Array.isArray(imageUrls) ? imageUrls : [])
        .filter((u) => typeof u === 'string' && u.trim())
        .slice(0, maxImages);

    if (images.length === 0) {
        const err = new Error("Cette publication n'a aucune image à analyser.");
        err.status = 400;
        throw err;
    }

    const pharmacies = [];
    // Une entrée par image, indexée comme `images` : permet de savoir
    // exactement lesquelles ont échoué, et de ne reprendre que celles-là.
    const echecs = new Map();
    let modeleUtilise = '';

    /** Lit une image et range le résultat. Renvoie true si elle a donné du texte. */
    const traiter = async (url) => {
        try {
            const resultat = await lireImage(url, modeles, prompt);
            if (resultat.modeleUtilise) modeleUtilise = resultat.modeleUtilise;
            pharmacies.push(...resultat.pharmacies);

            if (resultat.erreur) echecs.set(url, resultat.erreur);
            else echecs.delete(url);

            return resultat.pharmacies.length > 0;
        } catch (error) {
            // Une image illisible ne doit pas faire échouer tout le lot.
            console.error(`❌ OCR échoué sur ${url} :`, error.message);
            echecs.set(url, error.message);
            return false;
        }
    };

    for (const [index, url] of images.entries()) {
        if (index > 0) await pause(PAUSE_ENTRE_IMAGES_MS);
        await traiter(url);
    }

    // Seconde passe sur les images perdues.
    //
    // Sans elle, une saturation passagère du pool partagé — fréquente sur les
    // modèles `:free` — fait disparaître définitivement une affiche entière du
    // résultat : une publication de trois affiches n'en montrait qu'une, et
    // rien ne distinguait cette lecture partielle d'une affiche peu remplie.
    //
    // Inutile en revanche d'insister sur un quota JOURNALIER : il ne se libère
    // pas aujourd'hui, et réessayer ne ferait qu'ajouter une minute d'attente.
    const aReprendre = [...echecs.entries()]
        .filter(([, message]) => !/journalier|per day|daily/i.test(message))
        .map(([url]) => url);

    if (aReprendre.length > 0) {
        console.warn(
            `🔁 ${aReprendre.length} image(s) non lue(s) — seconde tentative dans ${PAUSE_SECONDE_PASSE_MS / 1000} s.`
        );
        await pause(PAUSE_SECONDE_PASSE_MS);

        for (const [index, url] of aReprendre.entries()) {
            if (index > 0) await pause(PAUSE_ENTRE_IMAGES_MS);
            if (await traiter(url)) console.log(`✅ Image récupérée à la seconde tentative : ${url.slice(0, 80)}`);
        }
    }

    const erreurs = [...echecs.entries()].map(([imageUrl, message]) => ({ imageUrl, message }));

    if (pharmacies.length === 0) {
        const err = new Error(
            erreurs[0]?.message || "Aucune pharmacie n'a pu être lue sur les images."
        );
        // 502 si le modèle a échoué, 422 si l'affiche ne contenait rien.
        err.status = erreurs.length ? 502 : 422;
        throw err;
    }

    // Dédoublonnage : la même pharmacie peut figurer sur deux images de la
    // publication. La ville fait partie de la clé — deux pharmacies de même nom
    // dans deux villes différentes sont bien deux entrées distinctes.
    const vues = new Set();
    const uniques = pharmacies.filter((p) => {
        const cle = `${p.ville.toLowerCase()}|${p.nom.toLowerCase()}|${p.adresse.toLowerCase()}`;
        if (vues.has(cle)) return false;
        vues.add(cle);
        return true;
    });

    // Regroupement par ville dans l'ordre d'apparition sur l'affiche : les
    // pharmacies d'une même ville restent ensemble, et l'ordre du document est
    // celui que le lecteur a sous les yeux.
    const ordreVilles = [];
    for (const p of uniques) {
        if (!ordreVilles.includes(p.ville)) ordreVilles.push(p.ville);
    }
    uniques.sort((a, b) => ordreVilles.indexOf(a.ville) - ordreVilles.indexOf(b.ville));

    // Texte lisible reconstitué à partir des données extraites. Le prompt ne
    // demande pas la transcription intégrale : elle doublerait le nombre de
    // tokens produits, au détriment du nombre de pharmacies effectivement lues.
    const texteBrut = uniques
        .map((p) => [p.ville, p.nom, p.adresse, p.telephones.join(' / ')].filter(Boolean).join(' — '))
        .join('\n');

    return {
        modele: modeleUtilise || modeles[0],
        images,
        pharmacies: uniques,
        texteBrut,
        nbVilles: ordreVilles.filter(Boolean).length,
        erreurs,
    };
}

module.exports = { lirePublication, MAX_IMAGES_DEFAUT };
