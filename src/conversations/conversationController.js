/**
 * conversationController.js
 *
 * Contrôleur Express pour le système de messagerie.
 */
const {
    getOrCreateConversation,
    getConversationsByUser,
    sendMessage,
    getMessages,
    markConversationAsRead,
} = require('./conversationService');

/**
 * POST /api/conversations
 * Crée ou récupère une conversation entre médecin et patient.
 * Body: { patientId } (si médecin) ou { medecinId } (si patient)
 */
exports.createOrGet = async (req, res) => {
    try {
        const userId = req.user.uid;
        const role = req.user.role;
        let medecinId, patientId;

        if (role === 'medecin') {
            medecinId = userId;
            patientId = req.body.patientId;
        } else {
            patientId = userId;
            medecinId = req.body.medecinId;
        }

        if (!medecinId || !patientId) {
            return res.status(400).json({ error: 'medecinId et patientId requis' });
        }

        const conversation = await getOrCreateConversation(medecinId, patientId);
        res.json(conversation);
    } catch (error) {
        console.error('Erreur createOrGet:', error.message);
        res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/conversations
 * Liste les conversations de l'utilisateur connecté.
 */
exports.list = async (req, res) => {
    try {
        const conversations = await getConversationsByUser(req.user.uid, req.user.role);
        res.json(conversations);
    } catch (error) {
        console.error('Erreur list conversations:', error.message);
        res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/conversations/:id/messages
 * Récupère les messages d'une conversation.
 */
exports.listMessages = async (req, res) => {
    try {
        const messages = await getMessages(req.params.id, req.user.uid);
        res.json(messages);
    } catch (error) {
        console.error('Erreur listMessages:', error.message);
        const status = error.message.includes('non autorisé') ? 403 : 500;
        res.status(status).json({ error: error.message });
    }
};

/**
 * POST /api/conversations/:id/messages
 * Envoie un message dans une conversation.
 * Body: { contenu }
 */
exports.send = async (req, res) => {
    try {
        const { contenu } = req.body;
        if (!contenu || !contenu.trim()) {
            return res.status(400).json({ error: 'Le message ne peut pas être vide' });
        }

        const message = await sendMessage(
            req.params.id,
            req.user.uid,
            req.user.role,
            contenu.trim()
        );
        res.status(201).json(message);
    } catch (error) {
        console.error('Erreur send:', error.message);
        const status = error.message.includes('non autorisé') ? 403 : 500;
        res.status(status).json({ error: error.message });
    }
};

/**
 * PUT /api/conversations/:id/read
 * Marque une conversation comme lue.
 */
exports.markRead = async (req, res) => {
    try {
        await markConversationAsRead(req.params.id, req.user.uid, req.user.role);
        res.json({ message: 'Conversation marquée comme lue' });
    } catch (error) {
        console.error('Erreur markRead:', error.message);
        res.status(500).json({ error: error.message });
    }
};
