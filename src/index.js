require('dotenv').config();
const os = require('os');
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
const etablissementRoutes = require('./routes/etablissementRoutes');
const geoRoutes = require('./routes/geoRoutes');
const { checkMissedMedications } = require('./services/checkMissedMedications');
const { verifierConfigurationMail } = require('./services/mailService');
const { planifierImportAutomatique } = require('./services/ingestionPharmacieGardeService');

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
app.use('/api/etablissements', etablissementRoutes);
app.use('/api/villes', geoRoutes);

const PORT = process.env.PORT || 5000;
/**
 * Adresse LAN de la machine, pour l'afficher au démarrage. Elle était codée en
 * dur, ce qui la rendait fausse dès un changement de réseau — et c'est
 * précisément cette valeur qu'il faut recopier dans EXPO_PUBLIC_API_BASE_URL
 * du .env.local de l'application pour qu'un téléphone joigne le backend.
 */
function adresseLan() {
    const interfaces = Object.values(os.networkInterfaces()).flat();
    const trouvee = interfaces.find((i) => i && i.family === 'IPv4' && !i.internal);
    return trouvee ? trouvee.address : 'localhost';
}

app.listen(PORT, "0.0.0.0", () => {
    const hote = adresseLan();
    console.log(`✅ Serveur Express accessible sur : http://${hote}:${PORT}`);
    console.log(`   → dans patient-med-app/.env.local : EXPO_PUBLIC_API_BASE_URL="http://${hote}:${PORT}/api"`);

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

    // Import périodique des pharmacies de garde depuis Facebook. Ne fait rien
    // tant que SCRAPING_INTERVAL_JOURS n'est pas renseigné : chaque passage
    // consomme du crédit Apify, et l'administrateur déclenche déjà l'import
    // depuis l'application. L'automatiser doit rester une décision explicite.
    planifierImportAutomatique();
});