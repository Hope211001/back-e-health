/**
 * notificationController.js
 *
 * Contrôleur Express pour les endpoints de notifications (médecin + patient).
 */
const {
    getNotificationsByUser,
    countUnread,
    markAsRead,
    markAllAsRead,
} = require('./notificationService');

/**
 * GET /api/notifications
 * Récupère les notifications de l'utilisateur connecté.
 */
exports.getNotifications = async (req, res) => {
    try {
        const notifications = await getNotificationsByUser(req.user.uid);
        res.json(notifications);
    } catch (error) {
        console.error('Erreur getNotifications:', error.message);
        res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/notifications/unread-count
 * Retourne le nombre de notifications non lues.
 */
exports.getUnreadCount = async (req, res) => {
    try {
        const count = await countUnread(req.user.uid);
        res.json({ count });
    } catch (error) {
        console.error('Erreur getUnreadCount:', error.message);
        res.status(500).json({ error: error.message });
    }
};

/**
 * PUT /api/notifications/:id/read
 * Marque une notification comme lue.
 */
exports.markRead = async (req, res) => {
    try {
        await markAsRead(req.params.id, req.user.uid);
        res.json({ message: 'Notification marquée comme lue' });
    } catch (error) {
        console.error('Erreur markRead:', error.message);
        const status = error.message.includes('introuvable') ? 404 :
                       error.message.includes('non autorisé') ? 403 : 500;
        res.status(status).json({ error: error.message });
    }
};

/**
 * PUT /api/notifications/read-all
 * Marque toutes les notifications comme lues.
 */
exports.markAllRead = async (req, res) => {
    try {
        const count = await markAllAsRead(req.user.uid);
        res.json({ message: `${count} notification(s) marquée(s) comme lue(s)` });
    } catch (error) {
        console.error('Erreur markAllRead:', error.message);
        res.status(500).json({ error: error.message });
    }
};
