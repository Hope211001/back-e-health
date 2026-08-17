/**
 * etablissementRoutes.js
 *
 * Écriture réservée au superadmin — enrôler ou retirer une structure est une
 * décision d'échelle nationale. Lecture ouverte à l'admin, que le contrôleur
 * restreint ensuite à son propre établissement.
 */
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/etablissementController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

router.get('/', verifyTokenAndRole(['admin', 'superadmin']), ctrl.listEtablissements);

// Déclaré APRÈS la racine mais AVANT toute autre route paramétrée, comme dans
// prescriptionRoutes : un chemin fixe ajouté plus tard sous `/:id` serait
// avalé comme un identifiant.
router.post('/', verifyTokenAndRole(['superadmin']), ctrl.createEtablissement);

router.get('/:id', verifyTokenAndRole(['admin', 'superadmin']), ctrl.getEtablissement);
router.patch('/:id', verifyTokenAndRole(['superadmin']), ctrl.updateEtablissement);
router.patch('/:id/statut', verifyTokenAndRole(['superadmin']), ctrl.toggleStatutEtablissement);

module.exports = router;
