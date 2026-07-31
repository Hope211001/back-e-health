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
const { checkMissedMedications } = require('./services/checkMissedMedications');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());


// 2. UTILISE LES ROUTES
app.use('/api/patients', patientRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/prescription', prescriptionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/pharmacie-garde', pharmacieGardeRoutes);
app.use('/api/stats', statsRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Serveur Express accessible sur : http://192.168.0.148:${PORT}`);

    // Vérification des médicaments manqués toutes les 15 min.
    // La tolérance étant de 1 h (TOLERANCE_MINUTES=60), un scan aux 15 min
    // suffit à détecter rapidement les oublis, tout en ménageant le quota Firestore.
    const CHECK_INTERVAL = 15 * 60 * 1000;
    setInterval(checkMissedMedications, CHECK_INTERVAL);
    console.log(`🔔 Vérification des médicaments manqués activée (toutes les 15 min)`);

    // NB : le ré-hébergement des images des pharmacies de garde est désormais
    // fait directement dans le workflow n8n (upload Cloudinary avant l'écriture
    // Firestore). L'ancien listener onSnapshot a été supprimé pour ne plus
    // consommer de quota Firestore en continu.
});