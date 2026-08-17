const { db } = require('../config/firebase');
const {
    normaliserId,
    perimetre,
    dansLePerimetre,
    verifierEtablissementActif,
} = require('../services/etablissementService');

/**
 * Groupes sanguins acceptés. Liste fermée et non texte libre : c'est une
 * donnée vitale, et « O+ », « o positif » ou « zéro + » saisis librement
 * deviendraient impossibles à comparer ou à filtrer par la suite.
 */
const GROUPES_SANGUINS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

/** Nombre maximal d'entrées par liste (allergies, antécédents). */
const MAX_ELEMENTS = 50;
/** Longueur maximale d'une entrée. */
const MAX_LONGUEUR = 120;

const erreur = (message) => {
    const err = new Error(message);
    err.status = 400;
    throw err;
};

/**
 * Groupe sanguin normalisé, ou '' (non renseigné).
 *
 * Facultatif : un médecin enregistre souvent un patient avant d'avoir le
 * résultat du typage. Mais une valeur fournie doit appartenir à la liste —
 * c'est sur cette donnée qu'une transfusion se déciderait.
 */
function groupeSanguinOptionnel(valeur) {
    if (valeur === undefined || valeur === null) return '';
    const propre = String(valeur).trim().toUpperCase().replace(/\s+/g, '');
    if (!propre) return '';
    if (!GROUPES_SANGUINS.includes(propre)) {
        erreur(`Groupe sanguin invalide : attendu ${GROUPES_SANGUINS.join(', ')}.`);
    }
    return propre;
}

/**
 * Liste de textes courts nettoyée : entrées vides retirées, espaces réduits,
 * doublons écartés.
 *
 * Le dédoublonnage est insensible à la casse et aux espaces : « Pénicilline »
 * et « pénicilline » sont la même allergie, et les voir deux fois dans un
 * dossier ferait douter de la fiabilité du reste.
 */
function listeTextes(valeur, libelle) {
    if (valeur === undefined || valeur === null) return [];
    if (!Array.isArray(valeur)) erreur(`${libelle} doit être une liste.`);
    if (valeur.length > MAX_ELEMENTS) {
        erreur(`${libelle} : ${MAX_ELEMENTS} entrées au maximum.`);
    }

    const vues = new Set();
    const sortie = [];
    for (const brut of valeur) {
        const propre = String(brut ?? '').trim().replace(/\s+/g, ' ');
        if (!propre) continue;
        if (propre.length > MAX_LONGUEUR) {
            erreur(`${libelle} : ${MAX_LONGUEUR} caractères au maximum par entrée.`);
        }
        const cle = propre.toLowerCase();
        if (vues.has(cle)) continue;
        vues.add(cle);
        sortie.push(propre);
    }
    return sortie;
}

// Récupérer les patients du médecin connecté
exports.getPatientsByMedecin = async (req, res) => {
    try {
        const medecinId = req.user.uid;
        console.log("🔍 Recherche patients pour le docteur UID :", medecinId);

        const snapshot = await db.collection('patients')
            .where('medecinTraitantId', '==', medecinId) 
            .get();

        const patients = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        console.log(`✅ ${patients.length} patients trouvés.`);
        res.json(patients);
    } catch (error) {
        console.error("❌ Erreur backend :", error.message);
        res.status(500).json({ error: error.message });
    }
};

// Rechercher un patient (par numéro ou email)
exports.searchPatients = async (req, res) => {
    try {
        const { q } = req.query;
        const medecinId = req.user.uid;

        // Note: Firestore backend ne permet pas facilement le "OR". 
        // On récupère les patients du médecin et on filtre en JS ou on fait 2 requêtes.
        const snapshot = await db.collection('patients')
            .where('medecinTraitantId', '==', medecinId)
            .get();

        const patients = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        const filtered = patients.filter(p => 
            p.numeroPatient.toLowerCase().includes(q.toLowerCase()) || 
            p.email.toLowerCase().includes(q.toLowerCase())
        );

        res.json(filtered);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};


/**
 * PATCH /api/patients/:id/dossier-medical
 * Groupe sanguin, allergies et antécédents d'un patient.
 *
 * Réservé au MÉDECIN TRAITANT du patient, et à lui seul :
 *   - un autre médecin n'a pas à écrire dans un dossier qu'il ne suit pas ;
 *   - l'administration non plus — ses écrans de dossier sont explicitement en
 *     lecture seule, un admin gère des comptes, pas des données médicales ;
 *   - le patient non plus : une allergie qu'il déclare doit être confirmée par
 *     son médecin avant de figurer au dossier dont dépendront les prescriptions.
 *
 * Un champ absent de la requête n'est pas touché : l'écran de détail peut ainsi
 * n'envoyer que la liste modifiée, sans risquer d'effacer les deux autres.
 */
exports.updateDossierMedical = async (req, res) => {
    try {
        const { id } = req.params;
        const { groupeSanguin, allergies, antecedents } = req.body;

        const ref = db.collection('patients').doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Patient non trouvé' });

        if (snap.data().medecinTraitantId !== req.user.uid) {
            return res.status(403).json({
                error: "Vous n'êtes pas le médecin traitant de ce patient.",
            });
        }

        const modifications = {};
        if (groupeSanguin !== undefined) {
            modifications.groupeSanguin = groupeSanguinOptionnel(groupeSanguin);
        }
        if (allergies !== undefined) {
            modifications.allergies = listeTextes(allergies, 'Les allergies');
        }
        if (antecedents !== undefined) {
            modifications.antecedents = listeTextes(antecedents, 'Les antécédents');
        }

        if (Object.keys(modifications).length === 0) {
            return res.json({ id, ...snap.data() });
        }

        // Trace de la dernière intervention : un dossier médical sans date de
        // mise à jour ne permet pas de savoir si « aucune allergie » signifie
        // « vérifié » ou « jamais renseigné ».
        modifications.dossierMedicalModifieLe = new Date().toISOString();
        modifications.dossierMedicalModifiePar = req.user.uid;

        await ref.update(modifications);
        res.json({ id, ...snap.data(), ...modifications });
    } catch (error) {
        console.error('Erreur updateDossierMedical:', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
};

/**
 * PATCH /api/patients/:id/transfert
 * Transfère un patient vers un autre établissement et un nouveau médecin
 * traitant. Admin (de l'établissement de départ ou d'arrivée) et superadmin.
 *
 * POURQUOI UNE OPÉRATION DÉDIÉE, et pas un simple changement de médecin :
 *
 * L'établissement d'un patient est une donnée à part entière, pas une
 * conséquence de qui le soigne. Si changer `medecinTraitantId` déplaçait
 * silencieusement le patient, alors muter un praticien emporterait sa file
 * entière vers un autre hôpital, et un dossier médical changerait de périmètre
 * sans que personne ne l'ait décidé ni ne puisse dire quand.
 *
 * Les deux champs bougent donc ENSEMBLE et laissent une trace. C'est ce qui
 * permet de répondre à « ce patient a-t-il toujours été suivi ici ? » — question
 * à laquelle un simple `etablissementId` ne répond pas.
 *
 * Ce qui n'est PAS transféré : les ordonnances passées gardent l'établissement
 * où elles ont été émises. Ce sont des faits datés ; les réécrire ferait
 * apparaître dans les statistiques d'un hôpital une activité qui a eu lieu
 * ailleurs.
 */
exports.transfererPatient = async (req, res) => {
    try {
        const { id } = req.params;

        const patientRef = db.collection('patients').doc(id);
        const patientSnap = await patientRef.get();
        if (!patientSnap.exists) return res.status(404).json({ error: 'Patient non trouvé' });

        const patient = patientSnap.data();
        const origine = normaliserId(patient.etablissementId);

        const destination = await verifierEtablissementActif(req.body.etablissementId);
        if (destination.id === origine) {
            return res.status(400).json({
                error: 'Ce patient est déjà suivi dans cet établissement.',
            });
        }

        // Le nouveau médecin traitant est obligatoire : un patient transféré
        // sans praticien sur place n'aurait personne pour lire ses alertes de
        // prise ni renouveler son traitement — le transfert le rendrait
        // invisible au lieu de le rattacher.
        const medecinId = String(req.body.medecinTraitantId || '').trim();
        if (!medecinId) {
            return res.status(400).json({
                error: "Le nouveau médecin traitant est requis (champ 'medecinTraitantId').",
            });
        }

        const medecinSnap = await db.collection('users').doc(medecinId).get();
        if (!medecinSnap.exists || medecinSnap.data().role !== 'medecin') {
            return res.status(400).json({ error: 'Le médecin traitant indiqué est introuvable.' });
        }
        if (normaliserId(medecinSnap.data().etablissementId) !== destination.id) {
            return res.status(400).json({
                error: `Ce médecin n'exerce pas à ${destination.nom}.`,
            });
        }

        // Un admin ne transfère qu'en lien avec SON établissement : il peut
        // orienter un de ses patients ailleurs, ou en accueillir un — mais pas
        // organiser un mouvement entre deux structures qui ne le concernent pas.
        const portee = perimetre(req);
        if (portee !== null && portee !== origine && portee !== destination.id) {
            return res.status(403).json({
                error: "Ce transfert ne concerne pas votre établissement.",
            });
        }

        const modifications = {
            etablissementId: destination.id,
            medecinTraitantId: medecinId,
            etablissementPrecedent: origine,
            transfereLe: new Date().toISOString(),
            transferePar: req.user.uid,
            motifTransfert: String(req.body.motif || '').trim().slice(0, 200),
        };

        const batch = db.batch();
        batch.update(patientRef, modifications);

        // `users` porte aussi `etablissementId` — c'est lui que lisent le
        // cloisonnement des listes et le middleware. Ne mettre à jour que
        // `patients` laisserait le patient dans son ancien périmètre pour tout
        // ce qui passe par son compte.
        const userRef = db.collection('users').doc(id);
        if ((await userRef.get()).exists) {
            batch.update(userRef, {
                etablissementId: destination.id,
                etablissementPrecedent: origine,
                transfereLe: modifications.transfereLe,
                transferePar: req.user.uid,
            });
        }
        await batch.commit();

        res.json({
            id,
            ...patient,
            ...modifications,
            etablissement: { id: destination.id, nom: destination.nom },
        });
    } catch (error) {
        console.error('Erreur transfererPatient:', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
};

exports.getPatientById = async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`🔍 Requête reçue pour le patient ID: [${id}] (Longueur: ${id.length})`);

        // 1. On cherche par l'ID du document
        let doc = await db.collection('patients').doc(id).get();

        // 2. Si non trouvé (ou ID tronqué), on cherche par le champ userId
        if (!doc.exists) {
            const snapshot = await db.collection('patients')
                .where('userId', '==', id)
                .limit(1)
                .get();
            
            if (!snapshot.empty) {
                doc = snapshot.docs[0];
            }
        }

        if (!doc.exists || (doc.empty && !doc.data)) {
            console.log("❌ Patient introuvable dans Firestore");
            return res.status(404).json({ error: "Patient non trouvé" });
        }

        // La route prend un identifiant en paramètre : sans cette garde, un
        // médecin qui connaîtrait l'id d'un patient d'un autre établissement
        // lirait sa fiche complète, ce que le filtrage des listes empêche par
        // ailleurs. Le superadmin, national, n'est pas concerné.
        if (!dansLePerimetre(req, doc.data())) {
            return res.status(403).json({
                error: "Ce patient est suivi dans un autre établissement.",
            });
        }

        console.log("✅ Patient trouvé :", doc.data().email);
        res.json({ id: doc.id, ...doc.data() });
    } catch (error) {
        console.error("Erreur serveur :", error.message);
        res.status(500).json({ error: error.message });
    }
};