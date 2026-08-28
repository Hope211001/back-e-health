/**
 * pharmacieGardeRoutes.js
 *
 * Routes CRUD pour la gestion des pharmacies de garde (partie admin / superadmin).
 */
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/pharmacieGardeController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

const ROLES = ['superadmin', 'admin'];

// Import depuis Facebook : scraping Apify, tri des publications par un modèle,
// ré-hébergement Cloudinary et écriture Firestore, le tout côté backend.
// Déclaré avant '/:id' pour qu'Express ne prenne pas 'scraping' pour un id.
router.post('/scraping', verifyTokenAndRole(ROLES), ctrl.lancerScraping);

// Côté patient : liste des pharmacies de garde visibles (avant '/:id').
router.get('/visible', verifyTokenAndRole(['patient', 'medecin', 'admin', 'superadmin']), ctrl.getVisible);

router.get('/', verifyTokenAndRole(ROLES), ctrl.getAll);
router.post('/', verifyTokenAndRole(ROLES), ctrl.create);
router.get('/:id', verifyTokenAndRole(ROLES), ctrl.getById);
router.put('/:id', verifyTokenAndRole(ROLES), ctrl.update);
router.patch('/:id/visibilite', verifyTokenAndRole(ROLES), ctrl.toggleVisibilite);
router.delete('/:id', verifyTokenAndRole(ROLES), ctrl.remove);

module.exports = router;
