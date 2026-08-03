/**
 * ocrRoutes.js
 *
 * Résultats d'OCR des affiches de pharmacies de garde (partie admin / superadmin).
 */
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/ocrController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

const ROLES = ['superadmin', 'admin'];

// La lecture d'un résultat est ouverte aux patients et médecins : c'est ce qui
// alimente la liste des pharmacies de garde côté patient. Le contrôleur vérifie
// que la publication est bien publiée avant de répondre à ces rôles.
const ROLES_LECTURE = ['superadmin', 'admin', 'medecin', 'patient'];

// Chemins spécifiques avant tout paramètre, pour qu'Express ne les avale pas.
router.get('/', verifyTokenAndRole(ROLES), ctrl.getAll);
router.get('/pharmacie-garde/:id', verifyTokenAndRole(ROLES_LECTURE), ctrl.getPourPharmacieGarde);
router.post('/pharmacie-garde/:id', verifyTokenAndRole(ROLES), ctrl.genererPourPharmacieGarde);
router.delete('/pharmacie-garde/:id', verifyTokenAndRole(ROLES), ctrl.remove);

module.exports = router;
