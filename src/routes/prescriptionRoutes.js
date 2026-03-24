// routes/prescriptionRoutes.js
const express = require('express');
const router = express.Router();
const prescriptionController = require('../controllers/prescriptionController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

// La route finale sera POST /api/prescription/
router.post('/', verifyTokenAndRole(['medecin']), prescriptionController.createPrescription);

// Ajoute cette ligne à tes routes existantes
router.get('/:id', verifyTokenAndRole(['medecin', 'patient', 'superadmin']), prescriptionController.getPrescriptionById);

// Les médecins et les patients (pour leur propre dossier) peuvent voir les prescriptions
router.get('/patient/:patientId', verifyTokenAndRole(['medecin']), prescriptionController.getPrescriptionsByPatient);

module.exports = router;