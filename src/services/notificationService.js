/**
 * notificationService.js
 *
 * Service Firestore pour la collection "notifications".
 * Gère la création, lecture et mise à jour des notifications médecin.
 */
const { admin, db } = require('../config/firebase');

const COLLECTION = 'notifications';

/**
 * Crée une notification dans Firestore.
 * @param {Object} data - Les données de la notification
 */
async function createNotification(data) {
    const notification = {
        medecinId: data.medecinId || '',
        patientId: data.patientId || '',
        destinataireId: data.destinataireId || data.medecinId || '',
        prescriptionId: data.prescriptionId || '',
        alerteId: data.alerteId || '',
        conversationId: data.conversationId || '',
        type: data.type || 'medication_manquee',
        titre: data.titre,
        message: data.message,
        nomMedicament: data.nomMedicament || '',
        heurePrevu: data.heurePrevu || '',
        lue: false,
        dateCreation: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection(COLLECTION).add(notification);
    return { id: docRef.id, ...notification };
}

/**
 * Récupère les notifications d'un utilisateur (destinataireId).
 * Fallback sur medecinId pour les anciennes notifications.
 */
async function getNotificationsByUser(userId, limit = 50) {
    // Récupérer par destinataireId
    const snap1 = await db.collection(COLLECTION)
        .where('destinataireId', '==', userId)
        .get();

    // Fallback : anciennes notifications par medecinId (sans destinataireId)
    const snap2 = await db.collection(COLLECTION)
        .where('medecinId', '==', userId)
        .get();

    // Fusionner sans doublons
    const seen = new Set();
    const allDocs = [...snap1.docs, ...snap2.docs].filter(doc => {
        if (seen.has(doc.id)) return false;
        seen.add(doc.id);
        return true;
    });

    const notifications = allDocs.map(doc => {
        const data = doc.data();
        return {
            id: doc.id,
            ...data,
            dateCreation: data.dateCreation?.toDate
                ? data.dateCreation.toDate().toISOString()
                : data.dateCreation,
        };
    });

    notifications.sort((a, b) => new Date(b.dateCreation).getTime() - new Date(a.dateCreation).getTime());
    return notifications.slice(0, limit);
}

/**
 * Compte les notifications non lues d'un utilisateur.
 */
async function countUnread(userId) {
    const snap1 = await db.collection(COLLECTION)
        .where('destinataireId', '==', userId)
        .where('lue', '==', false)
        .get();

    const snap2 = await db.collection(COLLECTION)
        .where('medecinId', '==', userId)
        .where('lue', '==', false)
        .get();

    const seen = new Set();
    let count = 0;
    [...snap1.docs, ...snap2.docs].forEach(doc => {
        if (!seen.has(doc.id)) { seen.add(doc.id); count++; }
    });
    return count;
}

/**
 * Marque une notification comme lue.
 */
async function markAsRead(notificationId, userId) {
    const docRef = db.collection(COLLECTION).doc(notificationId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
        throw new Error('Notification introuvable');
    }

    const data = docSnap.data();
    if (data.destinataireId !== userId && data.medecinId !== userId) {
        throw new Error('Accès non autorisé');
    }

    await docRef.update({ lue: true });
}

/**
 * Marque toutes les notifications d'un utilisateur comme lues.
 */
async function markAllAsRead(userId) {
    const snap1 = await db.collection(COLLECTION)
        .where('destinataireId', '==', userId)
        .where('lue', '==', false)
        .get();

    const snap2 = await db.collection(COLLECTION)
        .where('medecinId', '==', userId)
        .where('lue', '==', false)
        .get();

    const seen = new Set();
    const docsToUpdate = [...snap1.docs, ...snap2.docs].filter(doc => {
        if (seen.has(doc.id)) return false;
        seen.add(doc.id);
        return true;
    });

    if (docsToUpdate.length === 0) return 0;

    const batch = db.batch();
    docsToUpdate.forEach(doc => batch.update(doc.ref, { lue: true }));
    await batch.commit();

    return docsToUpdate.length;
}

module.exports = {
    createNotification,
    getNotificationsByUser,
    countUnread,
    markAsRead,
    markAllAsRead,
};
