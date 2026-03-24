const express = require('express');
const router = express.Router();
const patientController = require('../controllers/patientController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

// Route pour la liste
router.get('/', verifyTokenAndRole(['medecin']), patientController.getPatientsByMedecin);

// Route pour la recherche
router.get('/search', verifyTokenAndRole(['medecin']), patientController.searchPatients);

router.get('/:id', verifyTokenAndRole(['medecin', 'superadmin']), patientController.getPatientById);

module.exports = router;