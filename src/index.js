require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { db } = require('./config/firebase'); 

// 1. IMPORTE LES ROUTES
const patientRoutes = require('./routes/patientRoutes');
const authRoutes = require('./routes/authRoutes');
const prescriptionRoutes = require('./routes/prescriptionRoutes');
const notificationRoutes = require('./notifications/notificationRoutes');
const conversationRoutes = require('./conversations/conversationRoutes');
const { checkMissedMedications } = require('./notifications/checkMissedMedications');

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

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Serveur Express accessible sur : http://192.168.0.148:${PORT}`);

    // Vérification des médicaments manqués toutes les 10 minutes
    const CHECK_INTERVAL = 10 * 60 * 1000;
    setInterval(checkMissedMedications, CHECK_INTERVAL);
    console.log(`🔔 Vérification des médicaments manqués activée (toutes les 10 min)`);
});