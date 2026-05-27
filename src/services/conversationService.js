/**
 * conversationService.js
 *
 * Service Firestore pour les collections "conversations" et "messages".
 */
const { admin, db } = require('../config/firebase');
const { createNotification } = require('./notificationService');

const CONVERSATIONS = 'conversations';
const MESSAGES = 'messages';

/**
 * Récupère ou crée une conversation entre un médecin et un patient.
 */
async function getOrCreateConversation(medecinId, patientId) {
    // Chercher une conversation existante
    const snapshot = await db.collection(CONVERSATIONS)
        .where('medecinId', '==', medecinId)
        .where('patientId', '==', patientId)
        .limit(1)
        .get();

    if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        return { id: doc.id, ...doc.data() };
    }

    // Récupérer les noms
    const medecinNom = await getUserDisplayName(medecinId);
    const patientNom = await getUserDisplayName(patientId);

    // Créer une nouvelle conversation
    const newConv = {
        medecinId,
        patientId,
        medecinNom,
        patientNom,
        dernierMessage: '',
        dernierMessageDate: admin.firestore.FieldValue.serverTimestamp(),
        dernierMessagePar: '',
        nonLuMedecin: 0,
        nonLuPatient: 0,
    };

    const docRef = await db.collection(CONVERSATIONS).add(newConv);
    return { id: docRef.id, ...newConv };
}

/**
 * Récupère toutes les conversations d'un utilisateur (médecin ou patient).
 */
async function getConversationsByUser(userId, role) {
    const field = role === 'medecin' ? 'medecinId' : 'patientId';

    const snapshot = await db.collection(CONVERSATIONS)
        .where(field, '==', userId)
        .get();

    const conversations = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
            id: doc.id,
            ...data,
            dernierMessageDate: data.dernierMessageDate?.toDate
                ? data.dernierMessageDate.toDate().toISOString()
                : data.dernierMessageDate,
        };
    });

    // Tri en JS pour éviter l'index composite
    conversations.sort((a, b) => new Date(b.dernierMessageDate).getTime() - new Date(a.dernierMessageDate).getTime());
    return conversations;
}

/**
 * Envoie un message dans une conversation.
 */
async function sendMessage(conversationId, senderId, senderRole, contenu) {
    const convRef = db.collection(CONVERSATIONS).doc(conversationId);
    const convSnap = await convRef.get();

    if (!convSnap.exists) {
        throw new Error('Conversation introuvable');
    }

    const conv = convSnap.data();

    // Vérifier que l'utilisateur fait partie de la conversation
    if (senderId !== conv.medecinId && senderId !== conv.patientId) {
        throw new Error('Accès non autorisé');
    }

    // Créer le message dans la sous-collection
    const message = {
        conversationId,
        senderId,
        senderRole,
        contenu,
        dateEnvoi: admin.firestore.FieldValue.serverTimestamp(),
        lu: false,
    };

    const msgRef = await convRef.collection(MESSAGES).add(message);

    // Mettre à jour la conversation (dernier message + compteur non lu)
    const nonLuField = senderRole === 'medecin' ? 'nonLuPatient' : 'nonLuMedecin';
    await convRef.update({
        dernierMessage: contenu.length > 80 ? contenu.substring(0, 80) + '...' : contenu,
        dernierMessageDate: admin.firestore.FieldValue.serverTimestamp(),
        dernierMessagePar: senderId,
        [nonLuField]: admin.firestore.FieldValue.increment(1),
    });

    // Créer une notification pour le destinataire
    const recipientId = senderRole === 'medecin' ? conv.patientId : conv.medecinId;
    const senderName = senderRole === 'medecin' ? conv.medecinNom : conv.patientNom;
    const preview = contenu.length > 50 ? contenu.substring(0, 50) + '...' : contenu;

    try {
        await createNotification({
            medecinId: senderRole === 'patient' ? conv.medecinId : recipientId,
            patientId: senderRole === 'medecin' ? conv.patientId : recipientId,
            type: 'nouveau_message',
            titre: 'Nouveau message',
            message: `${senderName} : ${preview}`,
            destinataireId: recipientId,
            conversationId,
        });
    } catch (e) {
        console.error('Erreur notification message:', e.message);
    }

    return { id: msgRef.id, ...message, dateEnvoi: new Date().toISOString() };
}

/**
 * Récupère les messages d'une conversation (paginés).
 */
async function getMessages(conversationId, userId, limit = 50) {
    const convRef = db.collection(CONVERSATIONS).doc(conversationId);
    const convSnap = await convRef.get();

    if (!convSnap.exists) throw new Error('Conversation introuvable');

    const conv = convSnap.data();
    if (userId !== conv.medecinId && userId !== conv.patientId) {
        throw new Error('Accès non autorisé');
    }

    const snapshot = await convRef.collection(MESSAGES)
        .orderBy('dateEnvoi', 'desc')
        .limit(limit)
        .get();

    return snapshot.docs.map(doc => {
        const data = doc.data();
        return {
            id: doc.id,
            ...data,
            dateEnvoi: data.dateEnvoi?.toDate
                ? data.dateEnvoi.toDate().toISOString()
                : data.dateEnvoi,
        };
    }).reverse(); // Renvoyer dans l'ordre chronologique
}

/**
 * Marque tous les messages non lus d'une conversation comme lus pour un utilisateur.
 */
async function markConversationAsRead(conversationId, userId, role) {
    const convRef = db.collection(CONVERSATIONS).doc(conversationId);
    const convSnap = await convRef.get();

    if (!convSnap.exists) return;

    const conv = convSnap.data();
    if (userId !== conv.medecinId && userId !== conv.patientId) return;

    // Remettre le compteur non lu à 0
    const nonLuField = role === 'medecin' ? 'nonLuMedecin' : 'nonLuPatient';
    await convRef.update({ [nonLuField]: 0 });

    // Récupérer les messages non lus, filtrer en JS pour éviter l'index composite
    const unreadMessages = await convRef.collection(MESSAGES)
        .where('lu', '==', false)
        .get();

    // Garder uniquement les messages envoyés par l'autre personne
    const toUpdate = unreadMessages.docs.filter(doc => doc.data().senderId !== userId);

    if (toUpdate.length === 0) return;

    const batch = db.batch();
    toUpdate.forEach(doc => batch.update(doc.ref, { lu: true }));
    await batch.commit();
}

/**
 * Récupère le nom d'affichage d'un utilisateur.
 */
async function getUserDisplayName(uid) {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return 'Inconnu';
    const data = userDoc.data();
    const nom = `${data.prenom || ''} ${data.nom || ''}`.trim();
    return nom || data.email || 'Inconnu';
}

module.exports = {
    getOrCreateConversation,
    getConversationsByUser,
    sendMessage,
    getMessages,
    markConversationAsRead,
};
