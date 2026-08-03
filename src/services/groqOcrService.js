/**
 * groqOcrService.js
 *
 * OCR des affiches de pharmacies de garde via l'API Groq (endpoint compatible
 * OpenAI). On envoie l'URL de l'image à un modèle vision qui renvoie une
 * extraction structurée (nom, adresse, téléphones).
 *
 * La clé API vit UNIQUEMENT ici, côté serveur : elle ne doit jamais partir dans
 * le bundle de l'application mobile, où elle serait extractible.
 *
 * Variables d'environnement :
 *   - GROQ_API_KEY         (obligatoire)
 *   - GROQ_MODEL           (optionnel) modèle vision ; surchargeable sans
 *                          toucher au code si celui par défaut est retiré du
 *                          catalogue Groq.
 *   - GROQ_MAX_TOKENS      (optionnel) plafond de tokens par réponse.
 *   - GROQ_MAX_REESSAIS    (optionnel) réessais après un quota atteint.
 *   - GROQ_OCR_PROMPT      (optionnel) prompt en une seule variable. Pratique
 *                          pour un ajustement rapide, mais le JSON d'exemple
 *                          impose des échappements : préférer le fichier.
 *   - GROQ_OCR_PROMPT_FILE (optionnel) chemin du fichier de prompt, relatif au
 *                          dossier back-e-health. Par défaut :
 *                          src/prompts/ocr-pharmacie-garde.txt
 */
const fs = require('fs');
const path = require('path');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Seul modèle vision du catalogue Groq testé comme fonctionnel sur ce compte.
// Les Llama 4 (scout / maverick) ont été retirés ; llama-3.3, gpt-oss et
// groq/compound refusent le contenu multimodal ("content must be a string").
const MODELE_DEFAUT = 'qwen/qwen3.6-27b';

/**
 * Plafond de tokens de la réponse. L'offre gratuite refuse les requêtes trop
 * grosses ("Request too large") : monter cette valeur fait échouer l'appel au
 * lieu de rallonger le résultat. Surchargeable par GROQ_MAX_TOKENS.
 */
const MAX_TOKENS_DEFAUT = 3000;

/** Pause minimale entre deux images (l'attente réelle s'adapte au quota restant). */
const PAUSE_ENTRE_IMAGES_MS = 2000;

/** Nombre de réessais après un 429, en plus de la tentative initiale. */
const MAX_REESSAIS_DEFAUT = 2;

/**
 * Plafond d'attente après un 429. La limite de tokens de Groq se réinitialise
 * par fenêtre d'une minute : au-delà, c'est que le blocage vient d'ailleurs et
 * il vaut mieux rendre la main que faire patienter l'utilisateur sans fin.
 */
const ATTENTE_MAX_MS = 70000;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Convertit une durée Groq ("18.135s", "4m19.2s", "2s") en millisecondes.
 * Renvoie 0 si la valeur est absente ou non reconnue.
 */
function dureeEnMs(valeur) {
    const texte = String(valeur ?? '').trim();
    if (!texte) return 0;

    // `retry-after` est un nombre de secondes nu.
    if (/^\d+(\.\d+)?$/.test(texte)) return Math.round(parseFloat(texte) * 1000);

    const heures = texte.match(/(\d+(?:\.\d+)?)h/);
    const minutes = texte.match(/(\d+(?:\.\d+)?)m(?!s)/);
    const secondes = texte.match(/(\d+(?:\.\d+)?)s/);
    const ms = texte.match(/(\d+(?:\.\d+)?)ms/);

    const total =
        (heures ? parseFloat(heures[1]) * 3600000 : 0) +
        (minutes ? parseFloat(minutes[1]) * 60000 : 0) +
        (secondes ? parseFloat(secondes[1]) * 1000 : 0) +
        (ms ? parseFloat(ms[1]) : 0);

    return Math.round(total);
}

/** Extrait l'état du quota tokens depuis les en-têtes d'une réponse Groq. */
function lireQuota(reponse) {
    const restant = reponse.headers.get('x-ratelimit-remaining-tokens');
    return {
        restantTokens: restant == null ? null : Number(restant),
        resetMs: dureeEnMs(reponse.headers.get('x-ratelimit-reset-tokens')),
    };
}

/** Nombre d'images traitées au maximum pour une publication. */
const MAX_IMAGES = 5;

const FICHIER_PROMPT_DEFAUT = path.join(__dirname, '..', 'prompts', 'ocr-pharmacie-garde.txt');

/**
 * Dernier recours si la variable d'env est vide ET le fichier illisible : le
 * service doit rester fonctionnel même si quelqu'un supprime le .txt.
 */
const PROMPT_SECOURS = `Tu es un OCR d'affiches de pharmacies de garde.
Réponds UNIQUEMENT par un JSON valide de la forme :
{"texteBrut":"...","pharmacies":[{"nom":"","adresse":"","telephones":[]}]}
N'invente jamais de valeur : laisse vide ce qui est illisible.`;

/**
 * Prompt effectif, par ordre de priorité : variable d'env, puis fichier, puis
 * secours.
 *
 * Relu à chaque appel et non mis en cache : éditer le .txt prend effet à
 * l'analyse suivante, sans redémarrer le serveur. Le coût est une lecture
 * disque de quelques kilo-octets, négligeable devant l'appel réseau à Groq.
 */
function chargerPrompt() {
    const depuisEnv = (process.env.GROQ_OCR_PROMPT || '').trim();
    if (depuisEnv) return depuisEnv;

    const fichier = process.env.GROQ_OCR_PROMPT_FILE
        ? path.resolve(process.cwd(), process.env.GROQ_OCR_PROMPT_FILE)
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
 * Extrait un objet JSON d'une réponse de modèle, même si elle est entourée de
 * texte ou d'un bloc markdown (les modèles s'en écartent parfois malgré la
 * consigne et le response_format).
 */
function extraireJson(contenu) {
    // Les modèles à raisonnement (Qwen3) préfixent leur réponse d'un bloc
    // <think>…</think>. `reasoning_format: 'hidden'` le supprime normalement
    // côté Groq — ce retrait est la ceinture en plus des bretelles.
    const brut = String(contenu || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '')
        .trim();
    try {
        return JSON.parse(brut);
    } catch {
        const debut = brut.indexOf('{');
        const fin = brut.lastIndexOf('}');
        if (debut === -1 || fin <= debut) return null;
        try {
            return JSON.parse(brut.slice(debut, fin + 1));
        } catch {
            return null;
        }
    }
}

/** Normalise une entrée pharmacie renvoyée par le modèle. */
function normaliserPharmacie(p) {
    if (!p || typeof p !== 'object') return null;
    const nom = String(p.nom || '').trim();
    const adresse = String(p.adresse || '').trim();
    const telephones = Array.isArray(p.telephones)
        ? p.telephones.map((t) => String(t).trim()).filter(Boolean)
        : [];
    // Une entrée sans nom ni téléphone n'apporte rien.
    if (!nom && telephones.length === 0) return null;
    return { nom, adresse, telephones };
}

/**
 * Lance l'OCR sur une image et renvoie { texteBrut, pharmacies, tronque, quota }.
 *
 * Un 429 n'est pas un échec définitif : la limite de tokens de Groq se réarme
 * en moins d'une minute, et l'en-tête `retry-after` dit exactement combien de
 * temps attendre. On patiente et on réessaie plutôt que d'abandonner l'image —
 * sans ça, seule la première affiche d'une publication est lue.
 *
 * Lève une erreur portant un `status` HTTP exploitable par le contrôleur.
 */
async function lireImage(imageUrl, modele, prompt) {
    const cle = process.env.GROQ_API_KEY;
    if (!cle) {
        const err = new Error(
            "GROQ_API_KEY absente du .env du backend : l'OCR ne peut pas être lancé."
        );
        err.status = 503;
        throw err;
    }

    const maxTentatives = 1 + (Number(process.env.GROQ_MAX_REESSAIS) || MAX_REESSAIS_DEFAUT);
    let reponse;

    for (let tentative = 1; ; tentative++) {
        reponse = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${cle}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: modele,
                temperature: 0,
                max_tokens: Number(process.env.GROQ_MAX_TOKENS) || MAX_TOKENS_DEFAUT,
                response_format: { type: 'json_object' },
                // Indispensable avec un modèle à raisonnement : sans ça, il émet son
                // <think> avant le JSON et le mode json_object échoue en bloc
                // ("Failed to generate JSON"). Ignoré par les modèles non concernés.
                reasoning_format: 'hidden',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: imageUrl } },
                        ],
                    },
                ],
            }),
        });

        if (reponse.status !== 429 || tentative >= maxTentatives) break;

        // Groq annonce l'attente exacte ; à défaut on retombe sur la fenêtre de
        // réarmement des tokens, sinon sur une seconde de plus à chaque essai.
        const attente = Math.min(
            dureeEnMs(reponse.headers.get('retry-after')) ||
            dureeEnMs(reponse.headers.get('x-ratelimit-reset-tokens')) ||
            tentative * 1000,
            ATTENTE_MAX_MS,
        ) + 500; // marge : le compteur se réarme juste après l'instant annoncé

        console.warn(
            `⏳ Quota Groq atteint (essai ${tentative}/${maxTentatives}) — nouvelle tentative dans ${Math.round(attente / 1000)} s.`
        );
        await pause(attente);
    }

    if (!reponse.ok) {
        const detail = await reponse.text().catch(() => '');
        // Messages traduits pour les échecs courants : lus tels quels, ils
        // n'aident pas l'utilisateur de l'application.
        let message = `Groq a répondu ${reponse.status}. ${detail.slice(0, 300)}`;
        if (reponse.status === 429) {
            message = "Quota Groq épuisé malgré plusieurs tentatives. Réessayez dans une minute.";
        } else if (detail.includes('model_not_found') || detail.includes('does not exist')) {
            message = `Le modèle « ${modele} » n'existe pas ou n'est pas accessible avec cette clé. Corrigez GROQ_MODEL dans le .env.`;
        } else if (detail.includes('Request too large')) {
            message = "Requête trop grosse pour l'offre Groq actuelle : baissez GROQ_MAX_TOKENS.";
        }
        const err = new Error(message);
        err.status = reponse.status >= 400 && reponse.status < 500 ? reponse.status : 502;
        throw err;
    }

    const quota = lireQuota(reponse);
    const json = await reponse.json();
    const choix = json?.choices?.[0];
    const parse = extraireJson(choix?.message?.content);

    if (!parse) {
        const err = new Error("Réponse illisible du modèle : JSON attendu.");
        err.status = 502;
        throw err;
    }

    const pharmacies = Array.isArray(parse.pharmacies)
        ? parse.pharmacies.map(normaliserPharmacie).filter(Boolean)
        : [];

    return {
        // Le prompt par défaut ne demande plus la transcription intégrale (elle
        // consommait le budget de tokens au détriment des pharmacies) : on
        // recompose alors un texte lisible à partir des données extraites.
        texteBrut: String(parse.texteBrut || '').trim() || pharmacies
            .map((p) => [p.nom, p.adresse, p.telephones.join(' / ')].filter(Boolean).join(' — '))
            .join('\n'),
        pharmacies,
        // 'length' = le modèle a été coupé avant d'avoir fini : l'affiche
        // contient plus de pharmacies que ce que le quota laisse écrire.
        tronque: choix?.finish_reason === 'length',
        quota,
    };
}

/**
 * Lance l'OCR sur toutes les images d'une publication (MAX_IMAGES au plus) et
 * fusionne les résultats.
 *
 * Les images sont traitées en séquence et non en parallèle : les comptes Groq
 * gratuits ont une limite de requêtes par minute assez basse, et une rafale
 * ferait échouer tout le lot.
 */
async function lirePublication(imageUrls) {
    const modele = process.env.GROQ_MODEL || MODELE_DEFAUT;
    // Chargé une fois par publication : toutes ses images sont lues avec le
    // même prompt, même si le fichier est édité entre deux images.
    const prompt = chargerPrompt();
    const images = (Array.isArray(imageUrls) ? imageUrls : [])
        .filter((u) => typeof u === 'string' && u.trim())
        .slice(0, MAX_IMAGES);

    if (images.length === 0) {
        const err = new Error("Cette publication n'a aucune image à analyser.");
        err.status = 400;
        throw err;
    }

    const textes = [];
    const pharmacies = [];
    const erreurs = [];

    // Coût approximatif d'une analyse : le plafond de sortie plus les tokens
    // consommés par l'image elle-même. Sert à décider s'il reste assez de
    // quota pour enchaîner, ou s'il vaut mieux attendre le réarmement.
    const coutEstime = (Number(process.env.GROQ_MAX_TOKENS) || MAX_TOKENS_DEFAUT) + 2500;
    let quotaPrecedent = null;

    for (const [index, url] of images.entries()) {
        if (index > 0) {
            // Attente calculée sur le quota réellement restant plutôt que fixe :
            // inutile de patienter une minute s'il reste de la marge, et
            // insuffisant d'attendre 2 s s'il n'en reste plus.
            let attente = PAUSE_ENTRE_IMAGES_MS;
            if (
                quotaPrecedent?.restantTokens != null &&
                quotaPrecedent.restantTokens < coutEstime &&
                quotaPrecedent.resetMs > 0
            ) {
                attente = Math.min(quotaPrecedent.resetMs + 500, ATTENTE_MAX_MS);
                console.warn(
                    `⏳ Quota Groq insuffisant (${quotaPrecedent.restantTokens} tokens restants) — attente de ${Math.round(attente / 1000)} s avant l'image ${index + 1}/${images.length}.`
                );
            }
            await pause(attente);
        }

        try {
            const resultat = await lireImage(url, modele, prompt);
            quotaPrecedent = resultat.quota;
            if (resultat.texteBrut) textes.push(resultat.texteBrut);
            pharmacies.push(...resultat.pharmacies);
            if (resultat.tronque) {
                erreurs.push({
                    imageUrl: url,
                    message: "Affiche trop longue : la lecture a été coupée, toutes les pharmacies n'y sont pas.",
                });
            }
        } catch (error) {
            // Une image illisible ne doit pas faire échouer tout le lot : on
            // garde la trace de l'échec et on passe à la suivante.
            console.error(`❌ OCR échoué sur ${url} :`, error.message);
            erreurs.push({ imageUrl: url, message: error.message });
        }
    }

    if (pharmacies.length === 0 && textes.length === 0) {
        const err = new Error(
            erreurs[0]?.message || "Aucun texte n'a pu être extrait des images."
        );
        err.status = erreurs.length ? 502 : 422;
        throw err;
    }

    // Dédoublonnage : la même pharmacie peut figurer sur deux images du post.
    const vues = new Set();
    const uniques = pharmacies.filter((p) => {
        const cle = `${p.nom.toLowerCase()}|${p.adresse.toLowerCase()}`;
        if (vues.has(cle)) return false;
        vues.add(cle);
        return true;
    });

    return {
        modele,
        images,
        texteBrut: textes.join('\n\n'),
        pharmacies: uniques,
        erreurs,
    };
}

module.exports = { lirePublication, MAX_IMAGES };
