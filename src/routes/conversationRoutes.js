/**
 * conversationRoutes.js
 *
 * Routes Express pour le système de messagerie médecin ↔ patient.
 */
const express = require('express');
const router = express.Router();
const controller = require('../controllers/conversationController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

const ROLES = ['medecin', 'patient'];

router.get('/',              verifyTokenAndRole(ROLES), controller.list);
router.post('/',             verifyTokenAndRole(ROLES), controller.createOrGet);
router.get('/:id/messages',  verifyTokenAndRole(ROLES), controller.listMessages);
router.post('/:id/messages', verifyTokenAndRole(ROLES), controller.send);
router.put('/:id/read',      verifyTokenAndRole(ROLES), controller.markRead);

module.exports = router;
