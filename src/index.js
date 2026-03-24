require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { db } = require('./config/firebase'); 

// 1. IMPORTE LES ROUTES AUTH
const patientRoutes = require('./routes/patientRoutes');
const authRoutes = require('./routes/authRoutes');
const prescriptionRoutes= require('./routes/prescriptionRoutes')

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());


// 2. UTILISE LES ROUTES AUTH
app.use('/api/patients', patientRoutes);
app.use('/api/auth', authRoutes); 
app.use('/api/prescription', prescriptionRoutes)

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Serveur Express accessible sur : http://192.168.0.148:${PORT}`);
});