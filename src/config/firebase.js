const admin = require('firebase-admin');
require('dotenv').config();

// Vérification des variables pour t'aider à débugger
if (!process.env.FIREBASE_PRIVATE_KEY) {
  console.error("❌ ERREUR : La variable FIREBASE_PRIVATE_KEY est manquante dans le .env");
}

const firebaseConfig = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  // La correction magique pour les sauts de ligne :
  privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
};

// On initialise Firebase une seule fois
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig),
    });
    console.log("✅ Connexion à Firebase Admin réussie !");
  } catch (error) {
    console.error("❌ Erreur d'initialisation Firebase :", error.message);
    process.exit(1); // On arrête le serveur si Firebase ne marche pas (crucial pour ton projet)
  }
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = { db, auth };