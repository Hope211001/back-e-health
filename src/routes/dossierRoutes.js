/**
 * dossierRoutes.js
 *
 * Consultation en lecture seule des dossiers patients et médecins par
 * l'administration. Aucune écriture n'est exposée ici.
 */
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/dossierController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

const ROLES = ['admin', 'superadmin'];

router.get('/patient/:uid', verifyTokenAndRole(ROLES), ctrl.getDossierPatient);
router.get('/medecin/:uid', verifyTokenAndRole(ROLES), ctrl.getDossierMedecin);

module.exports = router;
