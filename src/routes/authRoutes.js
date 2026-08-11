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

// Les deux réponses à la proposition faite à la première connexion : définir
// son propre mot de passe, ou garder celui reçu par email. Ouvertes à tous les
// rôles — le contrôleur agit sur `req.user.uid`, chacun ne touche que le sien.
router.post(
    '/motdepasse',
    verifyTokenAndRole(['medecin', 'patient', 'admin', 'superadmin']),
    authController.changerMotDePasse
);
router.post(
    '/motdepasse/conserver',
    verifyTokenAndRole(['medecin', 'patient', 'admin', 'superadmin']),
    authController.conserverMotDePasse
);

// Renvoi des identifiants : génère un NOUVEAU mot de passe et l'envoie au
// titulaire. Ouvert à l'admin comme au superadmin — c'est une opération de
// dépannage courante (email en indésirables, SMTP tombé), pas un changement de
// droits, et l'admin ne voit jamais le mot de passe produit.
router.post(
    '/users/:uid/renvoyer-identifiants',
    verifyTokenAndRole(['admin', 'superadmin']),
    authController.renvoyerIdentifiants
);

router.get(
    '/profile/:uid',
    verifyTokenAndRole(['medecin', 'patient', 'admin', 'superadmin']),
    authController.getUserProfile
);

// Édition de l'état civil / du téléphone / de la photo. Le contrôleur affine
// ensuite : chacun son propre compte, le superadmin tous, l'admin seulement
// les médecins et les patients.
router.patch(
    '/profile/:uid',
    verifyTokenAndRole(['medecin', 'patient', 'admin', 'superadmin']),
    authController.updateUserProfile
);

router.post(
    '/logout',
    verifyTokenAndRole(['medecin', 'patient', 'admin', 'superadmin']),
    authController.logout
);

module.exports = router;
