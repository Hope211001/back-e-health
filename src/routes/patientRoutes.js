const express = require('express');
const router = express.Router();
const patientController = require('../controllers/patientController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

// Route pour la liste
router.get('/', verifyTokenAndRole(['medecin']), patientController.getPatientsByMedecin);

// Route pour la recherche
router.get('/search', verifyTokenAndRole(['medecin']), patientController.searchPatients);

router.get('/:id', verifyTokenAndRole(['medecin', 'superadmin']), patientController.getPatientById);

// Dossier médical : le contrôleur vérifie en plus que l'appelant est bien LE
// médecin traitant du patient, le rôle seul ne suffisant pas ici.
router.patch(
    '/:id/dossier-medical',
    verifyTokenAndRole(['medecin']),
    patientController.updateDossierMedical,
);

module.exports = router;