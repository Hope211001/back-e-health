/**
 * notificationRoutes.js
 *
 * Routes Express pour les notifications (médecin + patient).
 */
const express = require('express');
const router = express.Router();
const notificationController = require('./notificationController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

const ROLES = ['medecin', 'patient'];

router.get('/',              verifyTokenAndRole(ROLES), notificationController.getNotifications);
router.get('/unread-count',  verifyTokenAndRole(ROLES), notificationController.getUnreadCount);
router.put('/read-all',      verifyTokenAndRole(ROLES), notificationController.markAllRead);
router.put('/:id/read',      verifyTokenAndRole(ROLES), notificationController.markRead);

module.exports = router;
