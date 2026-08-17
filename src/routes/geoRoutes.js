/**
 * geoRoutes.js
 *
 * Référentiel des villes, monté sur `/api/villes`.
 *
 * Écriture : superadmin (le référentiel est national).
 * Lecture : tous les rôles authentifiés — un médecin renseigne la ville d'un
 * patient, un patient corrige la sienne dans son profil.
 */
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/geoController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

const TOUS = ['medecin', 'patient', 'admin', 'superadmin'];
const ECRITURE = ['superadmin'];

router.get('/', verifyTokenAndRole(TOUS), ctrl.listVilles);
router.post('/', verifyTokenAndRole(ECRITURE), ctrl.createVille);
router.patch('/:id', verifyTokenAndRole(ECRITURE), ctrl.updateVille);
router.patch('/:id/statut', verifyTokenAndRole(ECRITURE), ctrl.toggleStatutVille);

module.exports = router;
