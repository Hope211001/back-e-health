const { db, auth, admin } = require('../config/firebase');

// --- HELPERS ---
function formatTelephoneMalgache(tel) {
    let cleanTel = (tel || '').trim().replace(/[\s\-\.\(\)]/g, '');
    const hadPlus = cleanTel.startsWith('+');
    cleanTel = cleanTel.replace(/[^0-9]/g, '');
    if (cleanTel.startsWith('0')) cleanTel = cleanTel.substring(1);
    const formatted = hadPlus ? `+${cleanTel}` : `+261${cleanTel}`;
    const digits = formatted.replace(/\D/g, '');
    if (digits.length < 11 || digits.length > 15) {
        const err = new Error("Numéro de téléphone invalide. Format attendu : 034 XX XXX XX");
        err.status = 400;
        throw err;
    }
    return formatted;
}

// --- REGISTER PATIENT (par un medecin) ---
exports.registerPatient = async (req, res) => {
    try {
        const { email, password, tel } = req.body;
        const medecinId = req.user.uid;

        const formattedTel = formatTelephoneMalgache(tel);

        const userRecord = await admin.auth().createUser({
            email,
            password,
            phoneNumber: formattedTel
        });

        const uid = userRecord.uid;
        const batch = db.batch();

        const userRef = db.collection('users').doc(uid);
        const userBase = {
            uid,
            email,
            role: 'patient',
            telephone: formattedTel,
            statut: 'actif',
            authProvider: 'password',
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        const patientRef = db.collection('patients').doc(uid);
        const patientDetail = {
            id: uid,
            userId: uid,
            email,
            telephone: formattedTel,
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
        res.status(error.status || 400).json({ error: error.message });
    }
};

// --- REGISTER MEDECIN (par admin ou superadmin) ---
exports.registerMedecin = async (req, res) => {
    try {
        const { email, password, tel, spec, ordre } = req.body;
        const creePar = req.user.uid;

        const userRecord = await auth.createUser({ email, password });
        const uid = userRecord.uid;
        const batch = db.batch();

        const userBase = {
            uid,
            email,
            role: 'medecin',
            telephone: tel || '',
            statut: 'actif',
            authProvider: 'password',
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        const medecinDetail = {
            ...userBase,
            id: uid,
            userId: uid,
            specialite: Array.isArray(spec) ? spec : (spec ? [spec] : []),
            numeroOrdre: ordre || '',
            creePar
        };

        batch.set(db.collection('users').doc(uid), userBase);
        batch.set(db.collection('medecins').doc(uid), medecinDetail);
        await batch.commit();

        res.status(201).json(medecinDetail);
    } catch (error) {
        console.error("Erreur registration médecin:", error.message);
        res.status(400).json({ error: error.message });
    }
};

// --- REGISTER ADMIN (superadmin uniquement) ---
exports.registerAdmin = async (req, res) => {
    try {
        const { email, password, tel, nom, prenom } = req.body;
        const creePar = req.user.uid;

        const userRecord = await auth.createUser({ email, password });
        const uid = userRecord.uid;

        const userBase = {
            uid,
            email,
            role: 'admin',
            nom: nom || '',
            prenom: prenom || '',
            telephone: tel || '',
            statut: 'actif',
            authProvider: 'password',
            creePar,
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        await db.collection('users').doc(uid).set(userBase);

        res.status(201).json(userBase);
    } catch (error) {
        console.error("Erreur registration admin:", error.message);
        res.status(400).json({ error: error.message });
    }
};

// --- LOGIN classique (email/password déjà vérifié côté client) ---
exports.login = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: "Token manquant" });
        }
        const token = authHeader.split(' ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;

        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: "Profil utilisateur inexistant. Demandez à un administrateur de créer votre compte." });
        }

        const userData = userDoc.data();
        if (userData.statut === 'inactif') {
            return res.status(403).json({ error: "Compte désactivé. Contactez un administrateur." });
        }

        res.json({ uid, ...userData });
    } catch (error) {
        console.error("Erreur login:", error.message);
        res.status(401).json({ error: "Session non autorisée" });
    }
};

// --- GOOGLE SIGN-IN ---
// Premier login Google => crée un profil patient par défaut si inexistant.
// Les comptes medecin/admin/superadmin doivent être créés AVANT par un admin
// (sinon l'utilisateur Google sera créé en 'patient' par défaut).
exports.googleSignIn = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: "Token Google manquant" });
        }
        const token = authHeader.split(' ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;
        const email = decodedToken.email;
        const name = decodedToken.name || '';
        const picture = decodedToken.picture || '';

        const userRef = db.collection('users').doc(uid);
        const userSnap = await userRef.get();

        if (userSnap.exists) {
            const userData = userSnap.data();
            if (userData.statut === 'inactif') {
                return res.status(403).json({ error: "Compte désactivé. Contactez un administrateur." });
            }
            // Met à jour la photo / nom si vide
            const updates = {};
            if (!userData.photoURL && picture) updates.photoURL = picture;
            if (!userData.nom && name) updates.nom = name;
            if (Object.keys(updates).length) await userRef.update(updates);

            return res.json({ uid, ...userData, ...updates });
        }

        // Création automatique d'un profil patient par défaut
        const [prenom, ...rest] = name.split(' ');
        const userBase = {
            uid,
            email,
            role: 'patient',
            nom: rest.join(' ') || '',
            prenom: prenom || '',
            photoURL: picture,
            telephone: '',
            statut: 'actif',
            authProvider: 'google',
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        const patientDetail = {
            id: uid,
            userId: uid,
            email,
            numeroPatient: `PAT-${Date.now().toString().slice(-4)}`,
            medecinTraitantId: null,
            allergies: [],
            antecedents: [],
            statut: 'actif',
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        const batch = db.batch();
        batch.set(userRef, userBase);
        batch.set(db.collection('patients').doc(uid), patientDetail);
        await batch.commit();

        res.status(201).json({ uid, ...userBase });
    } catch (error) {
        console.error("Erreur Google Sign-In:", error.message);
        res.status(401).json({ error: "Échec authentification Google" });
    }
};

// --- FORGOT PASSWORD ---
// Génère un lien de réinitialisation Firebase et le renvoie.
// Le front peut l'envoyer par email (ou Firebase Auth envoie directement avec sendPasswordResetEmail côté client).
exports.forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Email requis" });

        try {
            await admin.auth().getUserByEmail(email);
        } catch {
            // On répond toujours 200 pour ne pas révéler si l'email existe
            return res.json({ message: "Si cet email existe, un lien a été envoyé." });
        }

        const link = await admin.auth().generatePasswordResetLink(email);

        // TODO : envoyer le lien par email via SendGrid/Mailgun.
        // Pour l'instant on le log côté serveur et on confirme au front.
        console.log(`🔑 Lien reset password pour ${email} : ${link}`);

        res.json({ message: "Si cet email existe, un lien a été envoyé." });
    } catch (error) {
        console.error("Erreur forgotPassword:", error.message);
        res.status(500).json({ error: "Erreur lors de la génération du lien" });
    }
};

// --- PROFILE ---
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

// --- LOGOUT ---
exports.logout = async (req, res) => {
    try {
        const uid = req.user.uid;
        await admin.auth().revokeRefreshTokens(uid);
        await db.collection('users').doc(uid).update({
            lastLogout: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ message: "Déconnexion réussie" });
    } catch (error) {
        console.error("Erreur Logout:", error);
        res.status(500).json({ error: "Erreur lors de la déconnexion" });
    }
};

// --- LISTE UTILISATEURS PAR ROLE (admin/superadmin) ---
exports.listUsersByRole = async (req, res) => {
    try {
        const { role } = req.query;
        let query = db.collection('users');
        if (role) query = query.where('role', '==', role);

        const snap = await query.get();
        const users = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
        res.json(users);
    } catch (error) {
        console.error("Erreur listUsersByRole:", error.message);
        res.status(500).json({ error: error.message });
    }
};

// --- TOGGLE STATUT (admin/superadmin) ---
exports.toggleUserStatut = async (req, res) => {
    try {
        const { uid } = req.params;
        const userRef = db.collection('users').doc(uid);
        const snap = await userRef.get();
        if (!snap.exists) return res.status(404).json({ error: "Utilisateur introuvable" });

        const current = snap.data().statut;
        const nouveau = current === 'actif' ? 'inactif' : 'actif';
        await userRef.update({ statut: nouveau });

        // Si on désactive : révoquer les tokens en cours
        if (nouveau === 'inactif') {
            await admin.auth().revokeRefreshTokens(uid);
        }

        res.json({ uid, statut: nouveau });
    } catch (error) {
        console.error("Erreur toggleUserStatut:", error.message);
        res.status(500).json({ error: error.message });
    }
};
