const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

// Seul un utilisateur avec le rôle 'medecin' peut enregistrer un patient
router.post('/login', authController.login);
router.post('/register-patient', verifyTokenAndRole(['medecin']), authController.registerPatient);
router.post('/register-medecin', authController.registerMedecin);
router.get('/profile/:uid', verifyTokenAndRole(['medecin', 'patient']), authController.getUserProfile);
router.post('/logout',
    verifyTokenAndRole(['medecin', 'patient', 'superadmin']),
    authController.logout
);
module.exports = router;