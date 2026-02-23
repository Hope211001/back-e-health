const express = require('express');
const router = express.Router();
const patientController = require('../controllers/patientController');

// GET /api/patients
router.get('/', patientController.getAllPatients);

// GET /api/patients/:id
router.get('/:id', patientController.getPatientById);

// Ton ancienne route POST
router.post('/', patientController.createPatient);

module.exports = router;