const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

// Public
router.post('/login', authController.login);
router.post('/google-signin', authController.googleSignIn);
router.post('/forgot-password', authController.forgotPassword);

// Patient créé par un médecin
router.post(
    '/register-patient',
    verifyTokenAndRole(['medecin']),
    authController.registerPatient
);

// Médecin créé par admin ou superadmin
router.post(
    '/register-medecin',
    verifyTokenAndRole(['admin', 'superadmin']),
    authController.registerMedecin
);

// Admin créé par superadmin uniquement
router.post(
    '/register-admin',
    verifyTokenAndRole(['superadmin']),
    authController.registerAdmin
);

// Liste utilisateurs (filtrage par role en query)
router.get(
    '/users',
    verifyTokenAndRole(['admin', 'superadmin']),
    authController.listUsersByRole
);

// Activer/désactiver un compte
router.patch(
    '/users/:uid/statut',
    verifyTokenAndRole(['admin', 'superadmin']),
    authController.toggleUserStatut
);

router.get(
    '/profile/:uid',
    verifyTokenAndRole(['medecin', 'patient', 'admin', 'superadmin']),
    authController.getUserProfile
);

router.post(
    '/logout',
    verifyTokenAndRole(['medecin', 'patient', 'admin', 'superadmin']),
    authController.logout
);

module.exports = router;
