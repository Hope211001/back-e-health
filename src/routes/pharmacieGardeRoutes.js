/**
 * pharmacieGardeRoutes.js
 *
 * Routes CRUD pour la gestion des pharmacies de garde (partie superadmin).
 */
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/pharmacieGardeController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

const ROLES = ['superadmin', 'admin'];

// NB : le workflow n8n écrit directement dans Firestore, images déjà ré-hébergées
// sur Cloudinary (upload fait dans n8n). Pas d'endpoint d'import ni de traitement
// d'images côté backend.
// Côté patient : liste des pharmacies de garde visibles (avant '/:id').
router.get('/visible', verifyTokenAndRole(['patient', 'medecin', 'admin', 'superadmin']), ctrl.getVisible);

router.get('/', verifyTokenAndRole(ROLES), ctrl.getAll);
router.post('/', verifyTokenAndRole(ROLES), ctrl.create);
router.get('/:id', verifyTokenAndRole(ROLES), ctrl.getById);
router.put('/:id', verifyTokenAndRole(ROLES), ctrl.update);
router.patch('/:id/visibilite', verifyTokenAndRole(ROLES), ctrl.toggleVisibilite);
router.delete('/:id', verifyTokenAndRole(ROLES), ctrl.remove);

module.exports = router;
