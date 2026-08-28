/**
 * ingestionPharmacieGardeService.js
 *
 * Import des publications de pharmacies de garde depuis une page Facebook.
 * Reprend le workflow n8n « pharmacie-de-garde », désormais dans le dépôt.
 *
 * Enchaînement, pour chaque passage :
 *   1. Apify scrape la page et renvoie les publications (apifyService) ;
 *   2. un modèle texte trie celles qui annoncent une liste de gardes ;
 *   3. les publications déjà en base sont ignorées (l'ID du document EST
 *      l'idpost Facebook, donc la vérification est un simple `doc().get()`) ;
 *   4. les images sont ré-hébergées sur Cloudinary — les URLs `fbcdn.net`
 *      expirent, les garder telles quelles donnerait des affiches mortes ;
 *   5. le document est écrit dans `pharamacieGarde`.
 *
 * Les publications sont traitées EN SÉQUENCE et non en parallèle : l'étape 2
 * appelle un modèle `:free` dont la limite par minute est basse, et une rafale
 * ferait échouer le lot entier.
 *
 * `isVisible` est posé à `false` : une affiche importée n'est pas encore
 * relue. C'est l'administrateur qui la publie depuis l'écran des pharmacies de
 * garde, après avoir vérifié l'OCR. Un import automatique qui rendrait
 * immédiatement visible une publication mal classée l'afficherait aux patients
 * sans qu'un humain l'ait vue.
 *
 * Variables d'environnement : voir apifyService.js et openRouterService.js, plus
 *   - CLASSIFICATION_PROMPT_FILE (optionnel) autre fichier de prompt de tri.
 */
const fs = require('fs');
const path = require('path');
const { admin, db } = require('../config/firebase');
const { recupererPublications } = require('./apifyService');
const { appelerModele, extraireJson, modelesTexte } = require('./openRouterService');
const { televerserDepuisUrl } = require('./cloudinaryService');

const COLLECTION = 'pharamacieGarde';

/** Pause entre deux publications, pour rester sous la limite par minute. */
const PAUSE_ENTRE_POSTS_MS = 1500;

/** Images ré-hébergées au plus par publication. */
const MAX_IMAGES_PAR_POST = 10;

const FICHIER_PROMPT_DEFAUT = path.join(__dirname, '..', 'prompts', 'classification-post.txt');

/** Dernier recours si le fichier de prompt est illisible. */
const PROMPT_SECOURS = `Cette publication Facebook annonce-t-elle une liste de pharmacies de garde ?
Réponds UNIQUEMENT par {"islist": true} ou {"islist": false}.

Texte de la publication :`;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Prompt de classification, relu à chaque import (comme le prompt d'OCR). */
function chargerPrompt() {
    const fichier = process.env.CLASSIFICATION_PROMPT_FILE
        ? path.resolve(process.cwd(), process.env.CLASSIFICATION_PROMPT_FILE)
        : FICHIER_PROMPT_DEFAUT;

    try {
        const contenu = fs.readFileSync(fichier, 'utf8').split(/^---\s*$/m)[0].trim();
        if (contenu) return contenu;
    } catch (error) {
        console.warn(`⚠️  Prompt de classification illisible (${fichier}) : ${error.message}`);
    }
    return PROMPT_SECOURS;
}

/**
 * Décide si une publication annonce une liste de pharmacies de garde.
 *
 * En cas d'échec du modèle, on retient la publication (`true`) plutôt que de
 * l'écarter : une publication non pertinente importée sera masquée d'un clic
 * par l'administrateur, alors qu'une liste écartée à cause d'une panne passagère
 * est perdue — la page Facebook ne la republiera pas.
 */
async function estListePharmacies(texte, prompt, modeles) {
    const contenuTexte = String(texte || '').trim();
    // Une publication sans texte n'est pas classable ; elle peut malgré tout
    // porter l'affiche en image, d'où le bénéfice du doute.
    if (!contenuTexte) return true;

    try {
        const { contenu, erreur } = await appelerModele({
            messages: [{ role: 'user', content: `${prompt}\n"""${contenuTexte}"""` }],
            modeles,
            maxTokens: 100,
        });

        if (erreur) {
            console.warn(`⚠️  Classification indisponible (${erreur}) — publication retenue par défaut.`);
            return true;
        }

        const parse = extraireJson(contenu);
        if (typeof parse?.islist !== 'boolean') {
            console.warn('⚠️  Réponse de classification illisible — publication retenue par défaut.');
            return true;
        }
        return parse.islist;
    } catch (error) {
        console.warn(`⚠️  Classification échouée (${error.message}) — publication retenue par défaut.`);
        return true;
    }
}

/**
 * URLs d'images d'une publication Apify.
 *
 * Seul `media[].image.uri` est exploitable : c'est l'URL directe obtenue par un
 * vrai navigateur. Les liens de page Facebook renvoient une page de blocage.
 */
function imagesDuPost(post) {
    return (Array.isArray(post?.media) ? post.media : [])
        .map((m) => m?.image?.uri)
        .filter((u) => typeof u === 'string' && u.trim())
        .slice(0, MAX_IMAGES_PAR_POST);
}

/**
 * Ré-héberge les images d'une publication sur Cloudinary.
 *
 * Une image qui échoue est conservée avec son URL Facebook d'origine plutôt que
 * d'être perdue : elle restera lisible quelques jours, ce qui laisse le temps de
 * relancer l'import. Le workflow n8n faisait déjà ce choix.
 */
async function rehebergerImages(urls, idpost) {
    const resultat = [];

    for (const [index, url] of urls.entries()) {
        try {
            resultat.push(await televerserDepuisUrl(url, `post-${idpost}-${index}`));
        } catch (error) {
            console.warn(`⚠️  Ré-hébergement échoué (${idpost}, image ${index}) : ${error.message}`);
            resultat.push(url);
        }
    }
    return resultat;
}

/**
 * Importe les publications d'une page Facebook.
 *
 * @param  {object} options
 * @param  {string} [options.pageUrl]      page à scraper
 * @param  {number} [options.resultsLimit] nombre de publications à examiner
 * @return {Promise<{ examinees, retenues, importees, ignorees, echecs, publications }>}
 */
async function importerPublications({ pageUrl, resultsLimit } = {}) {
    const posts = await recupererPublications({ pageUrl, resultsLimit });

    const bilan = {
        examinees: posts.length,
        retenues: 0,
        importees: 0,
        // Déjà en base : le cas normal d'un import régulier, pas une anomalie.
        ignorees: 0,
        echecs: [],
        publications: [],
    };

    if (posts.length === 0) return bilan;

    const prompt = chargerPrompt();
    const modeles = modelesTexte();

    for (const [index, post] of posts.entries()) {
        if (index > 0) await pause(PAUSE_ENTRE_POSTS_MS);

        // L'idpost sert d'identifiant de document : sans lui, impossible de
        // détecter les doublons à l'import suivant.
        const idpost = String(post?.postId || post?.id || '').trim();
        if (!idpost) {
            bilan.echecs.push({ idpost: '', message: 'Publication sans identifiant, ignorée.' });
            continue;
        }

        try {
            if (!(await estListePharmacies(post?.text, prompt, modeles))) continue;
            bilan.retenues += 1;

            const ref = db.collection(COLLECTION).doc(idpost);
            if ((await ref.get()).exists) {
                bilan.ignorees += 1;
                continue;
            }

            const images = imagesDuPost(post);
            const attachement = images.length ? await rehebergerImages(images, idpost) : [];

            await ref.set({
                idpost,
                urlPost: String(post?.url || '').trim(),
                textPost: String(post?.text || '').trim(),
                attachement,
                // Volontairement masqué : un administrateur relit l'affiche et
                // son OCR avant que les patients ne la voient.
                isVisible: false,
                dateCreation: admin.firestore.FieldValue.serverTimestamp(),
                dateModification: admin.firestore.FieldValue.serverTimestamp(),
            });

            bilan.importees += 1;
            bilan.publications.push({ idpost, nbImages: attachement.length });
        } catch (error) {
            // Une publication en échec ne doit pas interrompre les suivantes.
            console.error(`❌ Import échoué (${idpost}) :`, error.message);
            bilan.echecs.push({ idpost, message: error.message });
        }
    }

    console.log(
        `📥 Import pharmacies de garde : ${bilan.examinees} publication(s) examinée(s), `
        + `${bilan.retenues} retenue(s), ${bilan.importees} importée(s), `
        + `${bilan.ignorees} déjà connue(s), ${bilan.echecs.length} échec(s).`
    );

    return bilan;
}

/**
 * Import périodique, remplaçant le déclencheur hebdomadaire du workflow n8n.
 *
 * Désactivé par défaut (`SCRAPING_INTERVAL_JOURS` absent ou à 0) : chaque
 * passage consomme du crédit Apify, et l'administrateur déclenche déjà l'import
 * depuis l'application quand une nouvelle affiche paraît. Le rendre automatique
 * doit être une décision explicite.
 */
function planifierImportAutomatique() {
    const jours = Number(process.env.SCRAPING_INTERVAL_JOURS) || 0;
    if (jours <= 0) return;

    const intervalle = jours * 24 * 60 * 60 * 1000;
    setInterval(() => {
        importerPublications().catch((error) =>
            console.error('❌ Import automatique échoué :', error.message)
        );
    }, intervalle);

    console.log(`🗓️  Import automatique des pharmacies de garde activé (tous les ${jours} jour(s))`);
}

module.exports = { importerPublications, planifierImportAutomatique };
