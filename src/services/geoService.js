/**
 * geoService.js
 *
 * Référentiel des villes et communes.
 *
 * POURQUOI UNE COLLECTION PLUTÔT QU'UN CHAMP TEXTE. Avant, un établissement
 * portait sa ville comme une chaîne libre. Rien n'empêchait donc
 * « Antananarivo », « antananarivo » et « ANTANANARIVO » de coexister comme
 * trois villes distinctes : dans les statistiques nationales, une même commune
 * apparaissait alors sur trois lignes, et un filtre géographique en manquait
 * deux sur trois.
 *
 * Le libellé est désormais stocké UNE seule fois, dans `villes`, et référencé
 * ailleurs par son seul identifiant :
 *
 *     villes/{id}          { nom, statut }
 *     etablissements/{id}  { villeId, … }
 *     users/{id}           { villeId, … }
 *
 * Aucun nom de ville n'est jamais recopié sur les documents qui la
 * référencent : une commune renommée se propage partout sans migration. C'est
 * exactement le bénéfice attendu d'un schéma normalisé.
 *
 * Firestore n'ayant pas de jointure, la contrepartie habituelle serait une
 * lecture par ligne affichée. On l'évite parce que `villes` est un
 * RÉFÉRENTIEL : quelques centaines de communes au plus. On le charge donc en
 * entier, une fois par requête, et on résout les libellés en mémoire — le coût
 * est celui d'un schéma dénormalisé, sans la redondance.
 */
const { db } = require('../config/firebase');

const COLLECTION_VILLES = 'villes';

const erreur = (message, status = 400) => {
    const err = new Error(message);
    err.status = status;
    throw err;
};

/** Identifiant normalisé : chaîne vide pour « aucun ». */
function normaliserId(valeur) {
    return String(valeur ?? '').trim();
}

/**
 * Clé de comparaison d'un libellé : minuscules, sans accents, espaces réduits.
 *
 * C'est elle qui fait qu'« Antananarivo », « antananarivo » et « ANTANANARIVO »
 * sont refusées comme doublons au lieu de devenir trois villes distinctes.
 */
function cleLibelle(valeur) {
    return String(valeur ?? '')
        .trim()
        .toLowerCase()
        // `normalize('NFD')` sépare la lettre de son accent, `\p{Diacritic}`
        // retire ensuite l'accent seul. Écrit avec une classe Unicode nommée et
        // non avec une plage de caractères combinants littéraux : ceux-ci sont
        // invisibles dans un éditeur et se perdent silencieusement au moindre
        // changement d'encodage du fichier.
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/\s+/g, ' ');
}

/** Vérifie qu'une ville existe et est active. Renvoie le document. */
async function verifierVilleActive(id) {
    const propre = normaliserId(id);
    if (!propre) erreur('La ville est obligatoire.');

    const snap = await db.collection(COLLECTION_VILLES).doc(propre).get();
    if (!snap.exists) erreur('Ville introuvable.');
    if (snap.data().statut === 'inactif') {
        erreur('Cette ville est désactivée : aucun rattachement n’y est possible.');
    }
    return { id: snap.id, ...snap.data() };
}

/**
 * Référentiel complet des villes, en UNE lecture quelle que soit la taille de
 * la page affichée.
 *
 * C'est ce qui rend le schéma normalisé viable sur Firestore : au lieu d'une
 * jointure par ligne — impossible ici — on charge le référentiel entier, qui
 * reste petit par nature.
 *
 * @returns {Promise<Map<string, object>>} villeId → { id, nom, statut }
 */
async function chargerReferentielVilles() {
    const snap = await db.collection(COLLECTION_VILLES).get();

    const villes = new Map();
    snap.forEach((d) => {
        const v = d.data();
        villes.set(d.id, {
            id: d.id,
            nom: v.nom || '',
            statut: v.statut || 'actif',
        });
    });
    return villes;
}

/**
 * Bloc « ville » exposé au client.
 *
 * `null` pour les documents sans ville : les comptes antérieurs à ce champ, et
 * ceux dont la ville n'a pas été renseignée — elle reste facultative sur un
 * compte, contrairement à un établissement. `existe: false` signale en revanche
 * une anomalie réelle : une ville supprimée alors que des documents la
 * référencent encore.
 */
function blocVille(document, referentiel, champ = 'villeId') {
    const id = normaliserId(document?.[champ]);
    if (!id) return null;

    const trouve = referentiel.get(id);
    return {
        id,
        nom: trouve?.nom || '',
        statut: trouve?.statut || null,
        existe: Boolean(trouve),
    };
}

/**
 * Ajoute le bloc `ville` à une liste de documents, en une seule lecture du
 * référentiel. Raccourci pour le cas courant.
 */
async function enrichirVilles(documents, champ = 'villeId') {
    const referentiel = await chargerReferentielVilles();
    return documents.map((d) => ({ ...d, ville: blocVille(d, referentiel, champ) }));
}

module.exports = {
    COLLECTION_VILLES,
    normaliserId,
    cleLibelle,
    verifierVilleActive,
    chargerReferentielVilles,
    blocVille,
    enrichirVilles,
};
