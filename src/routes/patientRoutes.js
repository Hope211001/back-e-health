const express = require('express');
const router = express.Router();
const patientController = require('../controllers/patientController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

// Route pour la liste
router.get('/', verifyTokenAndRole(['medecin']), patientController.getPatientsByMedecin);

// Route pour la recherche
router.get('/search', verifyTokenAndRole(['medecin']), patientController.searchPatients);

router.get('/:id', verifyTokenAndRole(['medecin', 'superadmin']), patientController.getPatientById);

// Transfert vers un autre établissement, avec changement de médecin traitant.
// Réservé à l'administration : c'est un mouvement organisationnel, pas un acte
// de soin, et il fait franchir au dossier une frontière de périmètre.
router.patch(
    '/:id/transfert',
    verifyTokenAndRole(['admin', 'superadmin']),
    patientController.transfererPatient,
);

// Dossier médical : le contrôleur vérifie en plus que l'appelant est bien LE
// médecin traitant du patient, le rôle seul ne suffisant pas ici.
router.patch(
    '/:id/dossier-medical',
    verifyTokenAndRole(['medecin']),
    patientController.updateDossierMedical,
);

module.exports = router;