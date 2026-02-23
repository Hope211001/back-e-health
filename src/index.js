require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { db } = require('./config/firebase'); 
const patientRoutes = require('./routes/patientRoutes');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

// ROUTE DE TEST FIRESTORE
app.get('/test-db', async (req, res) => {
  try {
    // On essaie de lire une collection "test" (même si elle est vide)
    const snapshot = await db.collection('test').get();
    res.json({ 
      status: "success", 
      message: "Connexion Firestore active !",
      count: snapshot.size 
    });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get('/', (req, res) => {
    res.send("API E-Health opérationnelle");
});


// ... tes middlewares
app.use('/api/patients', patientRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Serveur lancé sur le port ${PORT}`);
});