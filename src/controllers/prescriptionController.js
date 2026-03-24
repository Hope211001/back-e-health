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
            statut: 'active',
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