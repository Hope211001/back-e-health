/**
 * dossierController.js
 *
 * Consultation des dossiers par l'administration (admin / superadmin).
 *
 * Les routes existantes de `patientController` et `prescriptionController` sont
 * réservées au médecin ET filtrées sur `req.user.uid` : un admin ne peut donc
 * pas s'en servir pour consulter le dossier d'un patient qui n'est pas le sien.
 * D'où ces endpoints dédiés, en LECTURE SEULE.
 *
 * Toutes les requêtes Firestore n'utilisent qu'une seule clause `where`, le tri
 * et les regroupements se faisant en JS : c'est la convention du projet, elle
 * évite d'avoir à créer des index composites.
 */
const { db } = require('../config/firebase');

/** Convertit un Timestamp Firestore (ou une date) en objet Date, sinon null. */
function toDate(valeur) {
    if (!valeur) return null;
    const d = valeur?.toDate ? valeur.toDate() : new Date(valeur);
    return isNaN(d.getTime()) ? null : d;
}

/** Tri décroissant sur la date de création (plus récent d'abord). */
function parDateDecroissante(a, b) {
    const da = toDate(a.dateCreation)?.getTime() ?? 0;
    const db_ = toDate(b.dateCreation)?.getTime() ?? 0;
    return db_ - da;
}

/** Identité affichable d'un compte, avec repli sur l'email. */
function identite(data) {
    if (!data) return '';
    const nom = `${data.prenom || ''} ${data.nom || ''}`.trim();
    return nom || data.email || '';
}

/** Prescriptions d'un champ donné (patientId ou medecinId), triées. */
async function lirePrescriptions(champ, valeur) {
    const snap = await db.collection('prescriptions').where(champ, '==', valeur).get();
    return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort(parDateDecroissante);
}

/**
 * GET /api/dossiers/patient/:uid
 * Dossier complet d'un patient : état civil, données médicales, médecin
 * traitant, prescriptions et observance des prises.
 */
exports.getDossierPatient = async (req, res) => {
    try {
        const { uid } = req.params;

        const [userSnap, patientSnap] = await Promise.all([
            db.collection('users').doc(uid).get(),
            db.collection('patients').doc(uid).get(),
        ]);

        if (!userSnap.exists) {
            return res.status(404).json({ error: 'Utilisateur introuvable.' });
        }
        const user = userSnap.data();
        if (user.role !== 'patient') {
            return res.status(400).json({ error: "Ce compte n'est pas un patient." });
        }

        const patient = patientSnap.exists ? patientSnap.data() : {};

        // Médecin traitant : le lien peut pointer vers un compte supprimé.
        let medecinTraitant = null;
        if (patient.medecinTraitantId) {
            const medSnap = await db.collection('users').doc(patient.medecinTraitantId).get();
            if (medSnap.exists) {
                const med = medSnap.data();
                medecinTraitant = {
                    uid: patient.medecinTraitantId,
                    nom: identite(med) || 'Médecin',
                    email: med.email || '',
                    telephone: med.telephone || '',
                };
            }
        }

        const prescriptions = await lirePrescriptions('patientId', uid);

        // Observance : répartition des prises sur toute la durée du suivi.
        const alertesSnap = await db.collection('alertes').where('patientId', '==', uid).get();
        const observance = { total: 0, pris: 0, manque: 0, en_attente: 0, autres: 0 };
        alertesSnap.forEach((d) => {
            const statut = d.data().statut;
            observance.total++;
            if (statut === 'pris') observance.pris++;
            else if (statut === 'manque') observance.manque++;
            else if (statut === 'en_attente') observance.en_attente++;
            else observance.autres++;
        });

        res.json({
            uid,
            identite: identite(user),
            email: user.email || '',
            telephone: user.telephone || '',
            statut: user.statut || 'actif',
            dateCreation: user.dateCreation || null,
            sexe: user.sexe || null,
            dateNaissance: user.dateNaissance || null,
            adresse: user.adresse || '',
            numeroPatient: patient.numeroPatient || '',
            groupeSanguin: patient.groupeSanguin || '',
            allergies: Array.isArray(patient.allergies) ? patient.allergies : [],
            antecedents: Array.isArray(patient.antecedents) ? patient.antecedents : [],
            horairesRappel: patient.horairesRappel || null,
            medecinTraitant,
            observance,
            nbPrescriptions: prescriptions.length,
            prescriptions,
        });
    } catch (error) {
        console.error('❌ getDossierPatient :', error.message);
        res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/dossiers/medecin/:uid
 * Dossier d'un médecin : identité, patients suivis et prescriptions émises.
 */
exports.getDossierMedecin = async (req, res) => {
    try {
        const { uid } = req.params;

        const [userSnap, medecinSnap] = await Promise.all([
            db.collection('users').doc(uid).get(),
            db.collection('medecins').doc(uid).get(),
        ]);

        if (!userSnap.exists) {
            return res.status(404).json({ error: 'Utilisateur introuvable.' });
        }
        const user = userSnap.data();
        if (user.role !== 'medecin') {
            return res.status(400).json({ error: "Ce compte n'est pas un médecin." });
        }

        const medecin = medecinSnap.exists ? medecinSnap.data() : {};

        const [patientsSnap, prescriptions] = await Promise.all([
            db.collection('patients').where('medecinTraitantId', '==', uid).get(),
            lirePrescriptions('medecinId', uid),
        ]);

        // Nombre de prescriptions par patient : évite une requête par patient.
        const parPatient = {};
        for (const p of prescriptions) {
            if (p.patientId) parPatient[p.patientId] = (parPatient[p.patientId] || 0) + 1;
        }

        const patients = patientsSnap.docs
            .map((d) => {
                const data = d.data();
                return {
                    uid: d.id,
                    identite: identite(data) || data.email || 'Patient',
                    email: data.email || '',
                    telephone: data.telephone || '',
                    numeroPatient: data.numeroPatient || '',
                    statut: data.statut || 'actif',
                    dateCreation: data.dateCreation || null,
                    nbPrescriptions: parPatient[d.id] || 0,
                };
            })
            .sort((a, b) => a.identite.localeCompare(b.identite));

        res.json({
            uid,
            identite: identite(user),
            email: user.email || '',
            telephone: user.telephone || '',
            statut: user.statut || 'actif',
            dateCreation: user.dateCreation || null,
            specialite: Array.isArray(medecin.specialite) ? medecin.specialite : [],
            numeroOrdre: medecin.numeroOrdre || '',
            nbPatients: patients.length,
            nbPrescriptions: prescriptions.length,
            patients,
            prescriptions,
        });
    } catch (error) {
        console.error('❌ getDossierMedecin :', error.message);
        res.status(500).json({ error: error.message });
    }
};
