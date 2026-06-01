const { db } = require('../config/firebase');

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

        console.log("✅ Patient trouvé :", doc.data().email);
        res.json({ id: doc.id, ...doc.data() });
    } catch (error) {
        console.error("Erreur serveur :", error.message);
        res.status(500).json({ error: error.message });
    }
};