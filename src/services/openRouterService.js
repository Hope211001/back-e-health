/**
 * openRouterService.js
 *
 * Client bas niveau de l'API OpenRouter (endpoint compatible OpenAI).
 * Partagé par les deux usages du projet :
 *   - la lecture des affiches de pharmacies de garde (modèle vision) ;
 *   - le tri des publications Facebook (modèle texte).
 *
 * La clé API vit UNIQUEMENT ici, côté serveur : elle ne doit jamais partir
 * dans le bundle de l'application mobile, où elle serait extractible.
 *
 * Pourquoi une liste de modèles et non un seul : les modèles `:free` sont
 * partagés entre tous les comptes OpenRouter et renvoient régulièrement un 429
 * « upstream rate-limited ». Le champ `models[]` fait basculer OpenRouter sur
 * le suivant de la liste sans nouvel aller-retour, et la réponse indique dans
 * son champ `model` celui qui a effectivement répondu — d'où sa remontée
 * jusqu'au document Firestore, sans quoi on afficherait un modèle qui n'a rien
 * lu.
 *
 * Variables d'environnement :
 *   - OPENROUTER_API_KEY  (obligatoire)
 *   - OPENROUTER_MODELES_VISION   (optionnel) liste séparée par des virgules
 *   - OPENROUTER_MODELES_TEXTE    (optionnel) idem
 *   - OPENROUTER_MAX_TOKENS       (optionnel) plafond de tokens par réponse
 *   - OPENROUTER_MAX_REESSAIS     (optionnel) réessais après un 429
 *   - OPENROUTER_SITE_URL / OPENROUTER_SITE_NOM (optionnels, en-têtes de
 *     classement OpenRouter — sans effet sur le résultat)
 */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Nombre de modèles transmis à OpenRouter. L'API refuse au-delà en 400
 * (« 'models' array must have 3 items or fewer »).
 */
const MAX_MODELES = 3;

/**
 * Modèles vision gratuits, mesurés sur une affiche de référence à 11 pharmacies
 * (chacun les a toutes trouvées) :
 *   gemma-4-26b  — la meilleure lecture sur une publication complète (31 entrées)
 *   dots-3-note  — 744 tokens, 3 s : le plus rapide, raisonnement désactivé
 *   minimax-m3   — 602 tokens, 6 s
 *
 * Trois FOURNISSEURS différents, et non les trois meilleurs modèles : gemma-31b
 * et gemma-26b passent tous deux par Google AI Studio et saturent donc
 * ENSEMBLE. Un repli vers un modèle du même pool ne replie sur rien.
 *
 * À revérifier via `GET https://openrouter.ai/api/v1/models` si tous renvoient
 * « model not found » — le catalogue `:free` bouge.
 */
const MODELES_VISION_DEFAUT =
    'google/gemma-4-26b-a4b-it:free, '
    + 'dots-studio/dots-3-note-preview:free, minimax/minimax-m3:free';

/** Modèles texte gratuits, pour la classification des publications. */
const MODELES_TEXTE_DEFAUT =
    'google/gemma-4-26b-a4b-it:free, minimax/minimax-m3:free, z-ai/glm-5.2:free';

/**
 * Plafond de tokens de la réponse. Une affiche de pharmacies de garde dépasse
 * couramment 40 entrées : en dessous de ~4000 tokens, la lecture est coupée en
 * cours de liste et les dernières villes disparaissent silencieusement.
 */
const MAX_TOKENS_DEFAUT = 4000;

/** Réessais après un 429, en plus de la tentative initiale. */
const MAX_REESSAIS_DEFAUT = 2;

/**
 * Attente de base après un 429, multipliée par le numéro d'essai.
 *
 * 5 s ne suffisaient pas : la saturation vient du POOL PARTAGÉ du modèle
 * gratuit (`limit_source: upstream_provider_shared_pool`), commun à tous les
 * comptes OpenRouter, et il se libère en dizaines de secondes. Réessayer trop
 * tôt consommait les trois tentatives en 10 s et abandonnait l'image — c'est
 * ainsi qu'une publication de 3 affiches n'en voyait qu'une seule lue.
 */
const ATTENTE_REESSAI_MS = 15000;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Découpe une liste de modèles « a, b, c » en tableau, en ignorant les vides.
 *
 * Tronquée à MAX_MODELES : au-delà, OpenRouter refuse TOUTE la requête en 400.
 * Écrêter avec un avertissement vaut mieux qu'un échec total sur chaque image
 * parce qu'une quatrième valeur a été ajoutée au .env.
 */
function listeModeles(valeur, defaut) {
    const brut = String(valeur || '').trim() || defaut;
    const liste = brut.split(',').map((m) => m.trim()).filter(Boolean);

    if (liste.length > MAX_MODELES) {
        console.warn(
            `⚠️  ${liste.length} modèles configurés, OpenRouter en accepte ${MAX_MODELES} : `
            + `les suivants sont ignorés (${liste.slice(MAX_MODELES).join(', ')}).`
        );
        return liste.slice(0, MAX_MODELES);
    }
    return liste;
}

/** Modèles vision configurés (OCR des affiches). */
const modelesVision = () =>
    listeModeles(process.env.OPENROUTER_MODELES_VISION, MODELES_VISION_DEFAUT);

/** Modèles texte configurés (classification des publications). */
const modelesTexte = () =>
    listeModeles(process.env.OPENROUTER_MODELES_TEXTE, MODELES_TEXTE_DEFAUT);

/**
 * Extrait un objet JSON d'une réponse de modèle, même si elle est entourée de
 * texte, d'un bloc markdown ou d'un raisonnement <think> (les modèles s'en
 * écartent parfois malgré la consigne et le response_format).
 */
function extraireJson(contenu) {
    const brut = String(contenu || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        // Un <think> jamais refermé signale une réponse coupée : tout ce qui
        // suit l'ouverture est du raisonnement, pas du JSON.
        .replace(/<think>[\s\S]*$/i, '')
        .replace(/```json/gi, '')
        .replace(/```/g, '')
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

/**
 * Message d'erreur le plus précis disponible dans une réponse OpenRouter.
 *
 * Particularité de l'API : un modèle saturé en amont ressort en HTTP 200 avec
 * un objet `error` dans le corps. Sans cette lecture, on prendrait une panne
 * pour une affiche vide de pharmacies.
 */
function erreurDuCorps(json) {
    const err = json?.error;
    if (!err) return null;
    return err?.metadata?.raw || err?.message || (typeof err === 'string' ? err : null);
}

/**
 * Appelle OpenRouter et renvoie { contenu, modeleUtilise, tronque, erreur }.
 *
 * N'échoue pas sur une erreur applicative du modèle : celle-ci est renvoyée
 * dans `erreur`, pour qu'une image illisible n'interrompe pas le traitement des
 * autres. Ne lève que si la requête elle-même est impossible (clé absente,
 * réseau coupé, refus HTTP définitif).
 *
 * @param {object}   options
 * @param {Array}    options.messages   messages au format OpenAI
 * @param {string[]} options.modeles    liste de repli (le 1er est le préféré)
 * @param {number}   [options.maxTokens]
 * @param {boolean}  [options.jsonStrict] demande `response_format: json_object`
 */
async function appelerModele({ messages, modeles, maxTokens, jsonStrict = true }) {
    const cle = (process.env.OPENROUTER_API_KEY || '').trim();
    if (!cle) {
        const err = new Error(
            "OPENROUTER_API_KEY absente du .env du backend : l'appel au modèle est impossible."
        );
        err.status = 503;
        throw err;
    }
    if (!Array.isArray(modeles) || modeles.length === 0) {
        const err = new Error('Aucun modèle OpenRouter configuré.');
        err.status = 503;
        throw err;
    }

    const corps = {
        model: modeles[0],
        // Repli automatique côté OpenRouter si le premier est saturé.
        models: modeles,
        temperature: 0,
        max_tokens: Number(process.env.OPENROUTER_MAX_TOKENS) || maxTokens || MAX_TOKENS_DEFAUT,
        // Le raisonnement est facturé sur le budget de SORTIE et n'apporte rien
        // à une transcription : `dots-3-note-preview` y dépensait 3029 tokens
        // sur 4000 et rendait une réponse tronquée, donc illisible. Désactivé,
        // il lit l'affiche entière en 744 tokens et 3 secondes. Ignoré par les
        // modèles sans mode raisonnement.
        reasoning: { enabled: false },
        messages,
    };
    // Tous les modèles gratuits n'annoncent pas `response_format`. On le demande
    // quand même : ceux qui ne le gèrent pas l'ignorent, et le prompt impose
    // déjà le JSON. L'extraction est de toute façon tolérante.
    if (jsonStrict) corps.response_format = { type: 'json_object' };

    const maxTentatives = 1 + (Number(process.env.OPENROUTER_MAX_REESSAIS) || MAX_REESSAIS_DEFAUT);
    let reponse;
    // Corps du dernier 429, relu pour le message final (le flux d'une réponse
    // ne se lit qu'une fois).
    let detail429 = '';

    for (let tentative = 1; ; tentative++) {
        try {
            reponse = await fetch(OPENROUTER_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${cle}`,
                    'Content-Type': 'application/json',
                    // Purement déclaratifs (classement public OpenRouter).
                    'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://mediora.mg',
                    'X-Title': process.env.OPENROUTER_SITE_NOM || 'Mediora',
                },
                body: JSON.stringify(corps),
            });
        } catch (error) {
            const err = new Error(`OpenRouter injoignable : ${error.message}`);
            err.status = 502;
            throw err;
        }

        if (reponse.status !== 429 || tentative >= maxTentatives) break;

        // Le corps du 429 dit LAQUELLE des limites a été touchée. Sans cette
        // lecture, on attendrait aussi longtemps pour un quota journalier —
        // qui, lui, ne se libérera pas aujourd'hui.
        detail429 = await reponse.text().catch(() => '');
        if (/free-models-per-day|per day|daily/i.test(detail429)) break;

        // Attente croissante : le pool partagé se libère par à-coups.
        const attente = ATTENTE_REESSAI_MS * tentative;
        console.warn(
            `⏳ Modèle gratuit saturé (essai ${tentative}/${maxTentatives}) — nouvelle tentative dans ${attente / 1000} s.`
        );
        await pause(attente);
    }

    if (!reponse.ok) {
        const detail = detail429 || await reponse.text().catch(() => '');
        // Messages traduits pour les échecs courants : lus tels quels, ils
        // n'aident pas l'utilisateur de l'application.
        let message = `OpenRouter a répondu ${reponse.status}. ${detail.slice(0, 300)}`;
        if (reponse.status === 401) {
            message = 'Clé OpenRouter refusée. Vérifiez OPENROUTER_API_KEY dans le .env.';
        } else if (reponse.status === 429) {
            message = /free-models-per-day|per day|daily/i.test(detail)
                ? "Quota JOURNALIER des modèles gratuits épuisé (50 requêtes/jour). "
                  + "Il se réarme demain ; acheter 10 $ de crédits OpenRouter le porte à 1000/jour."
                : "Modèles gratuits tous saturés (pool partagé entre tous les comptes OpenRouter) "
                  + "malgré plusieurs tentatives. Réessayez dans quelques minutes.";
        } else if (detail.includes('not a valid model') || detail.includes('No endpoints found')) {
            message =
                `Aucun des modèles configurés n'est disponible (${modeles.join(', ')}). `
                + 'Le catalogue gratuit évolue : corrigez OPENROUTER_MODELES_VISION / _TEXTE dans le .env.';
        }
        const err = new Error(message);
        err.status = reponse.status >= 400 && reponse.status < 500 ? reponse.status : 502;
        throw err;
    }

    const json = await reponse.json();
    const choix = json?.choices?.[0];

    return {
        contenu: choix?.message?.content || '',
        // Avec la liste de repli, ce n'est pas forcément le premier demandé.
        modeleUtilise: json?.model || modeles[0],
        // 'length' = le modèle a été coupé avant d'avoir fini.
        tronque: choix?.finish_reason === 'length',
        erreur: erreurDuCorps(json),
    };
}

module.exports = {
    appelerModele,
    extraireJson,
    modelesVision,
    modelesTexte,
    MODELES_VISION_DEFAUT,
    MODELES_TEXTE_DEFAUT,
};
