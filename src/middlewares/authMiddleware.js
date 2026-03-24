const { admin, db } = require('../config/firebase');

const verifyTokenAndRole = (rolesAutorises) => {
    return async (req, res, next) => {
        try {
            const authHeader = req.headers.authorization;

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: "Accès refusé. Token manquant." });
            }

            const token = authHeader.split(' ')[1]?.trim();
            
            // 1. Vérification du token par Firebase Admin
            const decodedToken = await admin.auth().verifyIdToken(token);
            const uid = decodedToken.uid;

            // 2. Vérification dans Firestore
            const userDoc = await db.collection('users').doc(uid).get();
            
            if (!userDoc.exists) {
                return res.status(404).json({ error: "Utilisateur non trouvé dans la base." });
            }

            const userData = userDoc.data();

            // 3. Vérification du rôle
            if (!rolesAutorises.includes(userData.role)) {
                return res.status(403).json({ error: "Accès interdit : privilèges insuffisants." });
            }

            req.user = { ...userData, uid: uid };
            next();
        } catch (error) {
            console.error("❌ Erreur Middleware Auth:", error.message);
            res.status(401).json({ error: "Session expirée ou token invalide." });
        }
    };
};

module.exports = { verifyTokenAndRole };