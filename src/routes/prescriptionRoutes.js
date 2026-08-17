// routes/prescriptionRoutes.js
const express = require('express');
const router = express.Router();
const prescriptionController = require('../controllers/prescriptionController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

// Créer une prescription (médecin uniquement)
router.post('/', verifyTokenAndRole(['medecin']), prescriptionController.createPrescription);

// --- Routes spécifiques AVANT les routes avec :id ---

// Alertes du patient (rappels du jour)
router.get('/alertes/today', verifyTokenAndRole(['patient']), prescriptionController.getAlertesToday);

// Marquer une prise depuis le CONTEXTE d'une notification (prescription +
// moment + médicament), quand l'identifiant de l'alerte n'est pas connu.
// Déclarée AVANT `/alertes/:id/pris` : « marquer-pris » serait sinon capté
// comme un `:id`, et l'appel échouerait en 404 sur une alerte inexistante.
router.put('/alertes/marquer-pris', verifyTokenAndRole(['patient']), prescriptionController.marquerPrisParContexte);

// Marquer une alerte comme prise
router.put('/alertes/:id/pris', verifyTokenAndRole(['patient']), prescriptionController.markAlertePrise);

// Prescriptions d'un patient (médecin uniquement)
router.get('/patient/:patientId', verifyTokenAndRole(['medecin']), prescriptionController.getPrescriptionsByPatient);

// --- Routes avec :id en dernier ---

// Récupérer une prescription par ID
router.get('/:id', verifyTokenAndRole(['medecin', 'patient', 'superadmin']), prescriptionController.getPrescriptionById);

// Le patient démarre sa prescription
router.put('/:id/start', verifyTokenAndRole(['patient']), prescriptionController.startPrescription);

// Le patient sauvegarde les horaires propres à une prescription
router.put('/:id/horaires', verifyTokenAndRole(['patient']), prescriptionController.updatePrescriptionHoraires);

module.exports = router;
