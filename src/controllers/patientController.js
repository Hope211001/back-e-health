const { db, auth } = require('../config/firebase');

exports.createPatient = async (req, res) => {
    try {
        const { email, password, nom, prenom, telephone, role, ...patientData } = req.body;

        // 1. Création du compte dans Firebase Auth
        const userRecord = await auth.createUser({
            email,
            password,
            displayName: `${prenom} ${nom}`,
            phoneNumber: telephone
        });

        // 2. Préparation de l'objet Patient selon ton interface TS
        const newPatient = {
            userId: userRecord.uid,
            nom,
            prenom,
            email,
            role: 'patient',
            telephone,
            statut: 'actif',
            dateCreation: new Date(), // Deviendra un Timestamp dans Firestore
            ...patientData // contient numeroPatient, groupeSanguin, allergies, etc.
        };

        // 3. Enregistrement dans Firestore
        await db.collection('patients').doc(userRecord.uid).set(newPatient);

        res.status(201).json({
            message: "Patient créé avec succès",
            patientId: userRecord.uid
        });

    } catch (error) {
        console.error("Erreur creation patient:", error);
        res.status(500).json({ error: error.message });
    }
};



// RÉCUPÉRER TOUS LES PATIENTS
exports.getAllPatients = async (req, res) => {
    try {
        const snapshot = await db.collection('patients').get();

        // On transforme le snapshot Firebase en un tableau d'objets JS
        const patients = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.status(200).json(patients);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération : " + error.message });
    }
};

// RÉCUPÉRER UN PATIENT PAR SON ID
exports.getPatientById = async (req, res) => {
    try {
        const patientId = req.params.id;
        const doc = await db.collection('patients').doc(patientId).get();

        if (!doc.exists) {
            return res.status(404).json({ message: "Patient non trouvé" });
        }

        res.status(200).json({ id: doc.id, ...doc.data() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};