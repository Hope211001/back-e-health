const { db, auth, admin } = require('../config/firebase');
exports.registerPatient = async (req, res) => {
    try {
        const { email, password, tel } = req.body;
        const medecinId = req.user.uid;

        // Nettoyage : on garde uniquement les chiffres et le + initial
        let cleanTel = (tel || '').trim().replace(/[\s\-\.\(\)]/g, '');
        const hadPlus = cleanTel.startsWith('+');
        cleanTel = cleanTel.replace(/[^0-9]/g, '');

        // Format malgache : on retire le 0 initial puis on préfixe +261
        if (cleanTel.startsWith('0')) {
            cleanTel = cleanTel.substring(1);
        }
        const formattedTel = hadPlus ? `+${cleanTel}` : `+261${cleanTel}`;

        // Validation longueur : numéro malgache mobile = 9 chiffres après +261
        const digitsAfterPlus = formattedTel.replace(/\D/g, '');
        if (digitsAfterPlus.length < 11 || digitsAfterPlus.length > 15) {
            return res.status(400).json({
                error: `Numéro de téléphone invalide. Format attendu : 034 XX XXX XX (ex: 0341234567)`
            });
        }

        // 1. Création Auth
        const userRecord = await admin.auth().createUser({
            email,
            password,
            phoneNumber: formattedTel
        });

        const uid = userRecord.uid;
        const batch = db.batch();

        // --- DOSSIER UTILISATEUR ---
        const userRef = db.collection('users').doc(uid); 
        const userBase = {
            uid: uid,
            email: email,
            role: 'patient',
            telephone: formattedTel, // ✅ Stocké ici
            statut: 'actif',
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        // --- DOSSIER MÉDICAL ---
        const patientRef = db.collection('patients').doc(uid); 
        const patientDetail = {
            id: uid,
            userId: uid,
            email: email,
            telephone: formattedTel, // 🟢 AJOUTÉ : Sinon il n'apparaît pas dans la fiche patient !
            numeroPatient: `PAT-${Date.now().toString().slice(-4)}`,
            medecinTraitantId: medecinId,
            allergies: [],
            antecedents: [],
            statut: 'actif',
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        batch.set(userRef, userBase);
        batch.set(patientRef, patientDetail);

        await batch.commit();

        res.status(201).json(patientDetail);

    } catch (error) {
        console.error("Erreur registerPatient:", error.message);
        res.status(400).json({ error: error.message });
    }
};



exports.registerMedecin = async (req, res) => {
    try {
        const { email, password, tel, spec, ordre } = req.body;

        const userRecord = await auth.createUser({ email, password });
        const uid = userRecord.uid;
        const batch = db.batch();

        const userBase = {
            uid,
            email,
            role: 'medecin',
            telephone: tel,
            statut: 'actif',
            // Maintenant "admin" est défini, donc cette ligne fonctionnera :
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        // ... le reste de ton code (batch.set, etc.)
        const medecinDetail = {
            ...userBase,
            id: uid,
            userId: uid,
            specialite: Array.isArray(spec) ? spec : [spec],
            numeroOrdre: ordre,
        };

        batch.set(db.collection('users').doc(uid), userBase);
        batch.set(db.collection('medecins').doc(uid), medecinDetail);

        await batch.commit();
        res.status(201).json(medecinDetail);

    } catch (error) {
        console.error("Erreur registration médecin:", error);
        res.status(400).json({ error: error.message });
    }
};

exports.getUserProfile = async (req, res) => {
    try {
        const uid = req.params.uid;
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ error: "Utilisateur non trouvé" });
        res.json(userDoc.data());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};


exports.login = async (req, res) => {
    try {
        // 1. Récupérer le token envoyé par l'intercepteur
        const authHeader = req.headers.authorization;
        const token = authHeader.split(' ')[1];

        // 2. Vérifier le token avec Firebase Admin
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;

        // 3. Récupérer le rôle dans Firestore
        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: "Profil utilisateur inexistant" });
        }

        // On renvoie les données (rôle, nom, etc.) au Front
        res.json({ uid, ...userDoc.data() });
    } catch (error) {
        console.error(error);
        res.status(401).json({ error: "Session non autorisée" });
    }
};


exports.logout = async (req, res) => {
    try {
        // req.user.uid est disponible grâce à ton middleware verifyToken
        const uid = req.user.uid;

        // 1. Révoquer tous les tokens de l'utilisateur dans Firebase Admin
        // Cela force l'utilisateur à se ré-authentifier la prochaine fois
        await admin.auth().revokeRefreshTokens(uid);

        // 2. Optionnel : Tu peux mettre à jour un champ 'derniereDeconnexion' dans Firestore
        await db.collection('users').doc(uid).update({
            lastLogout: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ message: "Déconnexion réussie sur le serveur" });
    } catch (error) {
        console.error("Erreur Logout Backend:", error);
        res.status(500).json({ error: "Erreur lors de la déconnexion" });
    }
};