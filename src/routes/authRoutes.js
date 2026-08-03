const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

// Public
router.post('/login', authController.login);
router.post('/google-signin', authController.googleSignIn);
router.post('/forgot-password', authController.forgotPassword);

// Patient créé par son médecin traitant, ou par l'administration. Dans ce
// second cas le médecin traitant ne peut pas être déduit du token : il doit
// être fourni dans le corps (`medecinId`).
router.post(
    '/register-patient',
    verifyTokenAndRole(['medecin', 'admin', 'superadmin']),
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

// Activer/désactiver un compte (médecin, patient ou admin) — superadmin uniquement.
// L'admin a un accès en lecture seule aux listes d'utilisateurs.
router.patch(
    '/users/:uid/statut',
    verifyTokenAndRole(['superadmin']),
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
