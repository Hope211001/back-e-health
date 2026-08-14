require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { db } = require('./config/firebase'); 

// 1. IMPORTE LES ROUTES
const patientRoutes = require('./routes/patientRoutes');
const authRoutes = require('./routes/authRoutes');
const prescriptionRoutes = require('./routes/prescriptionRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const conversationRoutes = require('./routes/conversationRoutes');
const pharmacieGardeRoutes = require('./routes/pharmacieGardeRoutes');
const statsRoutes = require('./routes/statsRoutes');
const ocrRoutes = require('./routes/ocrRoutes');
const dossierRoutes = require('./routes/dossierRoutes');
const { checkMissedMedications } = require('./services/checkMissedMedications');
const { verifierConfigurationMail } = require('./services/mailService');

const app = express();
app.use(helmet());
app.use(cors());
// Limite relevée par rapport aux 100 ko par défaut : les photos de profil sont
// transmises en base64 dans le corps JSON (voir services/cloudinaryService.js),
// et l'encodage gonfle déjà la taille d'un tiers.
app.use(express.json({ limit: '8mb' }));


// 2. UTILISE LES ROUTES
app.use('/api/patients', patientRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/prescription', prescriptionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/pharmacie-garde', pharmacieGardeRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/ocr', ocrRoutes);
app.use('/api/dossiers', dossierRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Serveur Express accessible sur : http://192.168.43.87:${PORT}`);

    // Vérification des médicaments manqués toutes les heures.
    // Le rythme est dicté par le quota Firestore, non par la réactivité voulue :
    // la requête relit toutes les alertes encore en attente — y compris celles
    // des jours suivants — donc chaque passage coûte autant de lectures qu'il
    // reste de doses à venir. À 15 min, le quota gratuit (50 000 lectures/jour)
    // était dépassé dès une trentaine de patients actifs ; à 1 h, la limite
    // recule au-delà de la centaine. La tolérance étant elle aussi de 1 h
    // (TOLERANCE_MINUTES=60), un oubli est signalé au médecin au plus tard
    // deux heures après l'heure de prise prévue, ce qui reste sans conséquence
    // pour un suivi d'observance.
    const CHECK_INTERVAL = 60 * 60 * 1000;
    setInterval(checkMissedMedications, CHECK_INTERVAL);
    console.log(`🔔 Vérification des médicaments manqués activée (toutes les heures)`);

    // Test du SMTP au démarrage : sans lui, un mot de passe d'application
    // erroné ne se découvre qu'à la première création de compte, c'est-à-dire
    // devant l'utilisateur. La fonction ne lève jamais — un serveur de courrier
    // en panne ne doit pas empêcher l'API de servir.
    verifierConfigurationMail();

    // NB : le ré-hébergement des images des pharmacies de garde est désormais
    // fait directement dans le workflow n8n (upload Cloudinary avant l'écriture
    // Firestore). L'ancien listener onSnapshot a été supprimé pour ne plus
    // consommer de quota Firestore en continu.
});