/**
 * etablissementService.js
 *
 * L'établissement de santé est l'unité d'organisation de la plateforme :
 * Mediora n'est pas le logiciel interne d'un hôpital, c'est un système déployé
 * à l'échelle d'un pays où chaque structure (CHU, CHRR, CSB, clinique…) gère
 * son propre périmètre.
 *
 * Trois niveaux, qui correspondent aux rôles :
 *   - superadmin  → portée NATIONALE, `etablissementId` vide, enrôle les
 *                   établissements et leurs administrateurs ;
 *   - admin       → un établissement et un seul ;
 *   - medecin/patient → celui de l'admin, puis du médecin, par héritage.
 *
 * L'héritage se fait À LA CRÉATION et la valeur est ensuite COPIÉE sur le
 * compte, jamais déduite à la lecture. Voir `etablissementDuMedecin` plus bas
 * pour le raisonnement complet — c'est le point de conception central du
 * module.
 */
const { db } = require('../config/firebase');
const { chargerReferentielVilles, blocVille } = require('./geoService');

const COLLECTION = 'etablissements';

/**
 * Types d'établissement de la pyramide sanitaire malgache, plus les structures
 * privées. Liste fermée et non texte libre, pour la même raison que les groupes
 * sanguins : « CSB II », « csb2 » et « Centre de santé de base niveau 2 » saisis
 * librement deviendraient impossibles à regrouper dans les statistiques.
 */
const TYPES_ETABLISSEMENT = [
    'CHU',      // Centre Hospitalier Universitaire
    'CHRR',     // Centre Hospitalier de Référence Régionale
    'CHRD',     // Centre Hospitalier de Référence de District
    'CSB2',     // Centre de Santé de Base niveau II
    'CSB1',     // Centre de Santé de Base niveau I
    'clinique', // Clinique privée
    'cabinet',  // Cabinet médical
    'autre',
];

const erreur = (message, status = 400) => {
    const err = new Error(message);
    err.status = status;
    throw err;
};

/**
 * Identifiant d'établissement normalisé : chaîne vide pour « aucun ».
 *
 * `''` et non `null` ou `undefined` : la comparaison de périmètre se fait sur
 * cette valeur, et trois formes différentes du vide donneraient trois
 * comportements différents selon qu'un compte est antérieur à ce champ, créé
 * sans, ou détaché depuis.
 */
function normaliserId(valeur) {
    return String(valeur ?? '').trim();
}

/** Type d'établissement validé. */
function typeEtablissement(valeur) {
    const propre = String(valeur ?? '').trim();
    if (!propre) erreur("Le type d'établissement est obligatoire.");
    if (!TYPES_ETABLISSEMENT.includes(propre)) {
        erreur(`Type d'établissement invalide : attendu ${TYPES_ETABLISSEMENT.join(', ')}.`);
    }
    return propre;
}

/**
 * Périmètre de l'appelant.
 *
 * `null` = portée nationale (superadmin) : aucun filtre à appliquer.
 * Une chaîne = l'établissement auquel il est cantonné, `''` compris — un admin
 * antérieur à ce champ ne voit alors que les comptes eux aussi non rattachés,
 * ce qui est exact plutôt que confortable, et se corrige par la migration.
 */
function perimetre(req) {
    if (req.user?.role === 'superadmin') return null;
    return normaliserId(req.user?.etablissementId);
}

/** Vrai si le document appartient au périmètre de l'appelant. */
function dansLePerimetre(req, doc) {
    const portee = perimetre(req);
    if (portee === null) return true;
    return normaliserId(doc?.etablissementId) === portee;
}

/** Filtre une liste de documents sur le périmètre de l'appelant. */
function filtrerParPerimetre(req, documents) {
    const portee = perimetre(req);
    if (portee === null) return documents;
    return documents.filter((d) => normaliserId(d?.etablissementId) === portee);
}

/**
 * Vérifie qu'un établissement existe et accepte de nouveaux comptes.
 *
 * Un établissement désactivé reste lisible — ses dossiers ne disparaissent
 * pas — mais on ne doit plus pouvoir y rattacher personne : ce serait créer un
 * compte dans une structure qui a quitté la plateforme.
 */
async function verifierEtablissementActif(id) {
    const propre = normaliserId(id);
    if (!propre) erreur("L'établissement de rattachement est obligatoire.");

    const snap = await db.collection(COLLECTION).doc(propre).get();
    if (!snap.exists) erreur("Établissement introuvable.");
    if (snap.data().statut === 'inactif') {
        erreur("Cet établissement est désactivé : aucun compte ne peut y être rattaché.");
    }
    return { id: snap.id, ...snap.data() };
}

/**
 * Établissement d'un nouveau compte créé par `req.user`.
 *
 * Règle : le créateur ne peut PAS sortir de son propre périmètre. Il n'a donc
 * rien à choisir — sauf le superadmin, qui n'a lui-même aucun établissement et
 * doit forcément désigner celui du compte qu'il crée.
 *
 * @param {object} req            requête authentifiée
 * @param {string} idDemande      `etablissementId` reçu dans le corps
 */
async function etablissementDuNouveauCompte(req, idDemande) {
    if (req.user?.role === 'superadmin') {
        // Le superadmin est national : il n'a aucun établissement à transmettre.
        await verifierEtablissementActif(idDemande);
        return normaliserId(idDemande);
    }

    const propre = normaliserId(req.user?.etablissementId);
    if (!propre) {
        erreur(
            "Votre compte n'est rattaché à aucun établissement : vous ne pouvez pas "
            + "créer d'utilisateur. Demandez à un super administrateur de vous rattacher.",
            409,
        );
    }
    // La valeur transmise par le client est ignorée, pas refusée : un écran qui
    // l'enverrait par erreur ne doit pas pouvoir déplacer un compte hors du
    // périmètre de son créateur.
    return propre;
}

/**
 * Établissement d'un patient : celui de son MÉDECIN TRAITANT au moment de la
 * création, copié sur le patient.
 *
 * Copié et non déduit à la lecture, pour trois raisons :
 *
 *  1. Un médecin est mobile, un patient ne l'est pas. Muter un praticien vers
 *     une autre structure déplacerait, rétroactivement et sans que personne ne
 *     l'ait décidé, tous les patients qu'il suit. Le rattachement est un fait
 *     organisationnel, pas une conséquence de qui soigne aujourd'hui.
 *  2. Firestore ne fait pas de jointure. Lister les patients d'un établissement
 *     imposerait de lire d'abord ses médecins puis d'interroger `patients` avec
 *     `medecinTraitantId in [...]` — clause plafonnée à 30 valeurs, donc
 *     cassée dès qu'une structure dépasse 30 praticiens.
 *  3. Un patient dont le médecin est supprimé ou désactivé n'appartiendrait
 *     plus à aucun établissement et disparaîtrait de toutes les listes, dossier
 *     médical compris.
 *
 * Le changement d'établissement est donc une opération explicite et tracée
 * (voir `transfererPatient` dans patientController), pas un effet de bord.
 */
function etablissementDuMedecin(medecin) {
    return normaliserId(medecin?.etablissementId);
}

/**
 * Résout les établissements d'un lot de comptes en UNE requête groupée
 * (`getAll`), sur le modèle de `resoudreCreateurs` : une lecture par ligne
 * affichée coûterait autant que la page elle-même.
 *
 * Le NOM n'est jamais recopié dans les comptes rattachés — il deviendrait faux
 * dès qu'un établissement est renommé (une fusion de structures, ça arrive).
 * Seul l'identifiant est stocké ; le nom est relu ici.
 *
 * @returns {Promise<Map<string, object>>} id → { id, nom, type, ville, region, statut }
 */
async function resoudreEtablissements(documents) {
    const ids = [...new Set(
        documents.map((d) => normaliserId(d?.etablissementId)).filter(Boolean)
    )];
    if (ids.length === 0) return new Map();

    // Le référentiel géographique est chargé en parallèle : un établissement ne
    // stocke plus que `villeId`, sa localisation doit donc être résolue elle
    // aussi. Deux niveaux de référence (compte → établissement → ville), mais
    // toujours un nombre FIXE de lectures, indépendant de la taille de la page.
    const [snaps, villes] = await Promise.all([
        db.getAll(...ids.map((id) => db.collection(COLLECTION).doc(id))),
        chargerReferentielVilles(),
    ]);

    const parId = new Map();
    for (const snap of snaps) {
        if (!snap.exists) continue;
        const data = snap.data();
        parId.set(snap.id, {
            id: snap.id,
            nom: data.nom || '',
            type: data.type || '',
            ville: blocVille(data, villes),
            statut: data.statut || 'actif',
        });
    }
    return parId;
}

/**
 * Bloc « établissement » exposé au client.
 *
 * `null` couvre deux cas qui ne sont pas des erreurs : le superadmin, national
 * par définition, et les comptes antérieurs à ce champ. `existe: false` signale
 * en revanche une anomalie réelle — un établissement supprimé de la base alors
 * que des comptes le référencent encore.
 */
function blocEtablissement(document, etablissements) {
    const id = normaliserId(document?.etablissementId);
    if (!id) return null;

    const trouve = etablissements.get(id);
    return {
        id,
        nom: trouve?.nom || '',
        type: trouve?.type || '',
        ville: trouve?.ville || null,
        statut: trouve?.statut || null,
        existe: Boolean(trouve),
    };
}

/**
 * Ajoute le bloc `etablissement` à une liste de comptes, en une seule requête.
 * Raccourci pour le cas courant `resoudreEtablissements` + `map`.
 */
async function enrichirEtablissements(documents) {
    const etablissements = await resoudreEtablissements(documents);
    return documents.map((d) => ({ ...d, etablissement: blocEtablissement(d, etablissements) }));
}

module.exports = {
    COLLECTION,
    TYPES_ETABLISSEMENT,
    normaliserId,
    typeEtablissement,
    perimetre,
    dansLePerimetre,
    filtrerParPerimetre,
    verifierEtablissementActif,
    etablissementDuNouveauCompte,
    etablissementDuMedecin,
    resoudreEtablissements,
    blocEtablissement,
    enrichirEtablissements,
};
