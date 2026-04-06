const { admin, db } = require('../config/firebase');

exports.createPrescription = async (req, res) => {
    try {
        const { patientId, diagnostic, medicaments, duree } = req.body;

        // Vérification de sécurité
        if (!patientId || !medicaments) {
            return res.status(400).json({ error: "Données manquantes (patientId ou médicaments)" });
        }

        const medecinId = req.user.uid;

        // 1. Calcul des dates correctement
        const dateDebut = new Date();
        const dateFin = new Date(); // <--- CORRECTION : Il faut déclarer la variable !

        const dureeInt = parseInt(duree) || 0;
        dateFin.setDate(dateDebut.getDate() + dureeInt);

        const newPrescription = {
            patientId,
            medecinId,
            diagnostic: diagnostic || '',
            medicaments,
            duree: dureeInt,
            dateCreation: admin.firestore.FieldValue.serverTimestamp(),
            dateDebut: admin.firestore.Timestamp.fromDate(dateDebut),
            dateFin: admin.firestore.Timestamp.fromDate(dateFin),
            statut: 'en_attente',
            creePar: medecinId
        };

        // 2. Sauvegarde dans Firestore
        const docRef = await db.collection('prescriptions').add(newPrescription);

        // 3. Réponse au front
        res.status(201).json({
            id: docRef.id,
            ...newPrescription,
            dateCreation: new Date() // Pour éviter l'erreur de sérialisation du FieldValue côté front
        });

    } catch (error) {
        console.error("Erreur createPrescription:", error.message);
        res.status(500).json({ error: error.message });
    }
};

exports.getPrescriptionsByPatient = async (req, res) => {
    try {
        const { patientId } = req.params;
        const snapshot = await db.collection('prescriptions')
            .where('patientId', '==', patientId)
            .orderBy('dateCreation', 'desc')
            .get();

        const data = snapshot.docs.map(doc => {
            const item = doc.data();
            
            return {
                id: doc.id,
                ...item,
                // On transforme les Timestamps Firebase en ISO String
                dateCreation: item.dateCreation?.toDate ? item.dateCreation.toDate().toISOString() : item.dateCreation,
                dateDebut: item.dateDebut?.toDate ? item.dateDebut.toDate().toISOString() : item.dateDebut,
                dateFin: item.dateFin?.toDate ? item.dateFin.toDate().toISOString() : item.dateFin
            };
        });

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.getPrescriptionById = async (req, res) => {
    try {
        const { id } = req.params;
        const doc = await db.collection('prescriptions').doc(id).get();

        if (!doc.exists) {
            return res.status(404).json({ error: "Ordonnance introuvable" });
        }

        const data = doc.data();

        // Sécurité
        if (req.user.uid !== data.medecinId && req.user.uid !== data.patientId && req.user.role !== 'superadmin') {
            return res.status(403).json({ error: "Accès non autorisé" });
        }

        // Conversion des Timestamps Firebase en format ISO String pour le Front
        const formattedData = {
            id: doc.id,
            ...data,
            dateCreation: data.dateCreation?.toDate ? data.dateCreation.toDate().toISOString() : data.dateCreation,
            // Fais de même pour dateDebut et dateFin si ce sont des Timestamps
            dateDebut: data.dateDebut?.toDate ? data.dateDebut.toDate().toISOString() : data.dateDebut,
            dateFin: data.dateFin?.toDate ? data.dateFin.toDate().toISOString() : data.dateFin,
        };

        res.json(formattedData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Parse la fréquence du médecin ("Matin: 1, Midi: 0, Soir: 2")
 * Retourne les moments où la quantité > 0 : ['matin', 'soir']
 */
function parseMomentsPrise(frequence) {
    if (!frequence) return ['matin', 'midi', 'soir'];

    const moments = [];
    const lower = frequence.toLowerCase();

    // Format "Matin: 1, Midi: 0, Soir: 2"
    const matinMatch = lower.match(/matin\s*:\s*(\d+)/);
    const midiMatch = lower.match(/midi\s*:\s*(\d+)/);
    const soirMatch = lower.match(/soir\s*:\s*(\d+)/);

    if (matinMatch || midiMatch || soirMatch) {
        if (matinMatch && parseInt(matinMatch[1]) > 0) moments.push('matin');
        if (midiMatch && parseInt(midiMatch[1]) > 0) moments.push('midi');
        if (soirMatch && parseInt(soirMatch[1]) > 0) moments.push('soir');
        return moments.length > 0 ? moments : ['matin', 'midi', 'soir'];
    }

    // Format texte libre ("3 fois par jour", "matin et soir", etc.)
    if (lower.includes('matin')) moments.push('matin');
    if (lower.includes('midi')) moments.push('midi');
    if (lower.includes('soir')) moments.push('soir');

    return moments.length > 0 ? moments : ['matin', 'midi', 'soir'];
}

/**
 * Le patient confirme le début de sa prise de médicament.
 * - Lit les horaires personnalisés du patient (matin/midi/soir)
 * - dateDebut = aujourd'hui, dateFin = aujourd'hui + duree, statut = 'en_cours'
 * - Génère les alertes en mappant Matin/Midi/Soir → heures du patient
 */
exports.startPrescription = async (req, res) => {
    try {
        const { id } = req.params;
        const patientId = req.user.uid;

        const docRef = db.collection('prescriptions').doc(id);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ error: "Ordonnance introuvable" });
        }

        const prescription = docSnap.data();

        if (prescription.patientId !== patientId) {
            return res.status(403).json({ error: "Accès non autorisé" });
        }

        if (prescription.statut === 'en_cours') {
            return res.status(400).json({ error: "Cette prescription est déjà en cours" });
        }
        if (prescription.statut === 'terminee') {
            return res.status(400).json({ error: "Cette prescription est déjà terminée" });
        }

        // Lire les horaires personnalisés du patient
        const patientDoc = await db.collection('patients').doc(patientId).get();
        const patientData = patientDoc.exists ? patientDoc.data() : {};
        const horaires = patientData.horairesRappel || {};
        const heuresMap = {
            matin: horaires.matin || '08:00',
            midi:  horaires.midi  || '12:00',
            soir:  horaires.soir  || '20:00',
        };

        // Calcul des nouvelles dates
        const dateDebut = new Date();
        const duree = parseInt(prescription.duree) || 7;
        const dateFin = new Date();
        dateFin.setDate(dateDebut.getDate() + duree);

        // Mise à jour de la prescription
        await docRef.update({
            dateDebut: admin.firestore.Timestamp.fromDate(dateDebut),
            dateFin: admin.firestore.Timestamp.fromDate(dateFin),
            statut: 'en_cours',
        });

        // Génération des alertes
        const batch = db.batch();
        const medicaments = prescription.medicaments || [];
        let alerteCount = 0;

        for (const med of medicaments) {
            const moments = parseMomentsPrise(med.frequence);
            const medDuree = parseInt(med.duree) || duree;

            for (let jour = 0; jour < medDuree; jour++) {
                for (const moment of moments) {
                    const datePrise = new Date(dateDebut);
                    datePrise.setDate(datePrise.getDate() + jour);

                    const alerteRef = db.collection('alertes').doc();
                    batch.set(alerteRef, {
                        patientId,
                        prescriptionId: id,
                        medicamentId: med.id || med.nomMedicament,
                        nomMedicament: med.nomMedicament,
                        dosage: med.dosage || '',
                        moment: moment,
                        heurePrevu: heuresMap[moment],
                        datePrise: admin.firestore.Timestamp.fromDate(datePrise),
                        statut: 'en_attente',
                        notificationEnvoyee: false,
                    });
                    alerteCount++;
                }
            }
        }

        await batch.commit();

        res.json({
            message: "Prescription démarrée avec succès",
            dateDebut: dateDebut.toISOString(),
            dateFin: dateFin.toISOString(),
            statut: 'en_cours',
            alertesCrees: alerteCount,
        });
    } catch (error) {
        console.error("Erreur startPrescription:", error.message);
        res.status(500).json({ error: error.message });
    }
};

/**
 * Récupère les alertes du jour pour le patient connecté
 */
exports.getAlertesToday = async (req, res) => {
    try {
        const patientId = req.user.uid;

        // Début et fin de la journée
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

        // Un seul where pour éviter l'index composite, filtrage date en JS
        const snapshot = await db.collection('alertes')
            .where('patientId', '==', patientId)
            .get();

        const alertes = snapshot.docs
            .map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    ...data,
                    datePrise: data.datePrise?.toDate ? data.datePrise.toDate().toISOString() : data.datePrise,
                    prisLe: data.prisLe?.toDate ? data.prisLe.toDate().toISOString() : data.prisLe,
                };
            })
            .filter(a => {
                const d = new Date(a.datePrise);
                return d >= startOfDay && d < endOfDay;
            });

        // Trier par heurePrevu
        alertes.sort((a, b) => a.heurePrevu.localeCompare(b.heurePrevu));

        res.json(alertes);
    } catch (error) {
        console.error("Erreur getAlertesToday:", error.message);
        res.status(500).json({ error: error.message });
    }
};

/**
 * Le patient marque une alerte comme "pris"
 */
exports.markAlertePrise = async (req, res) => {
    try {
        const { id } = req.params;
        const patientId = req.user.uid;

        const docRef = db.collection('alertes').doc(id);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ error: "Alerte introuvable" });
        }

        if (docSnap.data().patientId !== patientId) {
            return res.status(403).json({ error: "Accès non autorisé" });
        }

        await docRef.update({
            statut: 'pris',
            prisLe: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.json({ message: "Médicament marqué comme pris" });
    } catch (error) {
        console.error("Erreur markAlertePrise:", error.message);
        res.status(500).json({ error: error.message });
    }
};

exports.getPatientById = async (req, res) => {
    try {
        const { id } = req.params;
        const doc = await db.collection('patients').doc(id).get();

        if (!doc.exists) {
            return res.status(404).json({ error: "Patient non trouvé" });
        }

        res.json({ id: doc.id, ...doc.data() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};