const admin = require('firebase-admin');
require('dotenv').config();

const firebaseConfig = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
};

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig),
      // Bucket Storage pour ré-héberger les images (pharmacies de garde, etc.).
      // À définir dans .env : FIREBASE_STORAGE_BUCKET=e-health-cb942.appspot.com
      // (ou e-health-cb942.firebasestorage.app selon Firebase Console → Storage).
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${firebaseConfig.projectId}.appspot.com`,
    });
    console.log("✅ Backend : Firebase Admin Initialisé");
  } catch (error) {
    console.error("❌ Backend : Erreur d'initialisation :", error.message);
  }
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = { db, auth, admin }; // Crucial : exporte admin