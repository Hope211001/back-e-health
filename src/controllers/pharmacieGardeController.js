/**
 * pharmacieGardeController.js
 *
 * CRUD sur la collection "pharamacieGarde", et déclenchement de l'import des
 * publications depuis une page Facebook (services/ingestionPharmacieGardeService.js).
 *
 * Champs d'un document :
 *   - idpost      : string   (identifiant du post source, souvent = ID du doc)
 *   - isVisible   : boolean  (affiché ou non côté public)
 *   - urlPost     : string   (lien vers le post/page)
 *   - textPost    : string   (contenu texte du post)
 *   - attachement : string[] (URLs des pièces jointes / images)
 */
const { admin, db } = require('../config/firebase');
const { importerPublications } = require('../services/ingestionPharmacieGardeService');

const COLLECTION = 'pharamacieGarde';

/** Normalise un document Firestore vers l'objet renvoyé au client. */
const mapDoc = (doc) => {
    const data = doc.data() || {};
    return {
        id: doc.id,
        idpost: data.idpost || doc.id,
        isVisible: data.isVisible === true,
        urlPost: data.urlPost || '',
        textPost: data.textPost || '',
        attachement: Array.isArray(data.attachement) ? data.attachement : [],
        dateCreation: data.dateCreation || null,
        dateModification: data.dateModification || null,
    };
};

/**
 * POST /api/pharmacie-garde/scraping
 * Importe les publications d'une page Facebook (scraping + tri + Cloudinary).
 *
 * Corps : { pageUrl?, resultsLimit? }
 *
 * L'appel est synchrone et peut durer plusieurs minutes : le scraping attend la
 * fin de l'actor Apify, puis chaque publication retenue enchaîne un appel de
 * classification et un ré-hébergement d'images. L'application le sait et
 * n'attend pas la réponse au-delà de son propre délai — l'import, lui, va
 * jusqu'au bout côté serveur.
 */
exports.lancerScraping = async (req, res) => {
    try {
        const { pageUrl, resultsLimit } = req.body || {};
        const bilan = await importerPublications({ pageUrl, resultsLimit });
        res.json(bilan);
    } catch (error) {
        console.error('❌ lancerScraping pharmacieGarde :', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
};

// GET /api/pharmacie-garde/visible  (côté patient : seulement les visibles)
exports.getVisible = async (req, res) => {
    try {
        // Un seul where => pas d'index composite requis.
        const snapshot = await db.collection(COLLECTION).where('isVisible', '==', true).get();
        const list = snapshot.docs.map(mapDoc);

        // Tri décroissant (plus récent d'abord) sur l'idpost Facebook (numérique).
        list.sort((a, b) => {
            const na = Number(a.idpost);
            const nb = Number(b.idpost);
            if (!isNaN(na) && !isNaN(nb)) return nb - na;
            return String(b.idpost).localeCompare(String(a.idpost));
        });

        res.json(list);
    } catch (error) {
        console.error('❌ getVisible pharmacieGarde :', error.message);
        res.status(500).json({ error: error.message });
    }
};

// GET /api/pharmacie-garde  (?q=recherche)
exports.getAll = async (req, res) => {
    try {
        const { q } = req.query;
        const snapshot = await db.collection(COLLECTION).get();
        let list = snapshot.docs.map(mapDoc);

        // Recherche en JS (Firestore ne fait pas de "contains" texte simple)
        if (q && q.trim()) {
            const needle = q.trim().toLowerCase();
            list = list.filter((p) =>
                p.textPost.toLowerCase().includes(needle) ||
                p.urlPost.toLowerCase().includes(needle) ||
                p.idpost.toLowerCase().includes(needle)
            );
        }

        res.json(list);
    } catch (error) {
        console.error('❌ getAll pharmacieGarde :', error.message);
        res.status(500).json({ error: error.message });
    }
};

// GET /api/pharmacie-garde/:id
exports.getById = async (req, res) => {
    try {
        const doc = await db.collection(COLLECTION).doc(req.params.id).get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Pharmacie de garde introuvable.' });
        }
        res.json(mapDoc(doc));
    } catch (error) {
        console.error('❌ getById pharmacieGarde :', error.message);
        res.status(500).json({ error: error.message });
    }
};

// POST /api/pharmacie-garde
exports.create = async (req, res) => {
    try {
        const { idpost, isVisible, urlPost, textPost, attachement } = req.body;

        if (!urlPost || !urlPost.trim()) {
            return res.status(400).json({ error: "Le champ 'urlPost' est requis." });
        }

        const payload = {
            idpost: (idpost || '').trim(),
            isVisible: isVisible === true,
            urlPost: urlPost.trim(),
            textPost: (textPost || '').trim(),
            attachement: Array.isArray(attachement)
                ? attachement.filter((a) => typeof a === 'string' && a.trim())
                : [],
            dateCreation: admin.firestore.FieldValue.serverTimestamp(),
            dateModification: admin.firestore.FieldValue.serverTimestamp(),
        };

        // Si un idpost est fourni, on l'utilise comme ID de document (cohérent
        // avec l'import automatique) ; sinon on laisse Firestore générer l'ID.
        let ref;
        if (payload.idpost) {
            ref = db.collection(COLLECTION).doc(payload.idpost);
            await ref.set(payload);
        } else {
            ref = await db.collection(COLLECTION).add(payload);
            await ref.update({ idpost: ref.id });
        }

        const doc = await ref.get();
        res.status(201).json(mapDoc(doc));
    } catch (error) {
        console.error('❌ create pharmacieGarde :', error.message);
        res.status(500).json({ error: error.message });
    }
};

// PUT /api/pharmacie-garde/:id
exports.update = async (req, res) => {
    try {
        const { id } = req.params;
        const ref = db.collection(COLLECTION).doc(id);
        const doc = await ref.get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Pharmacie de garde introuvable.' });
        }

        const { isVisible, urlPost, textPost, attachement } = req.body;
        const updates = { dateModification: admin.firestore.FieldValue.serverTimestamp() };

        if (isVisible !== undefined) updates.isVisible = isVisible === true;
        if (urlPost !== undefined) updates.urlPost = String(urlPost).trim();
        if (textPost !== undefined) updates.textPost = String(textPost).trim();
        if (attachement !== undefined) {
            updates.attachement = Array.isArray(attachement)
                ? attachement.filter((a) => typeof a === 'string' && a.trim())
                : [];
        }

        await ref.update(updates);
        const updated = await ref.get();
        res.json(mapDoc(updated));
    } catch (error) {
        console.error('❌ update pharmacieGarde :', error.message);
        res.status(500).json({ error: error.message });
    }
};

// PATCH /api/pharmacie-garde/:id/visibilite  (bascule isVisible)
exports.toggleVisibilite = async (req, res) => {
    try {
        const { id } = req.params;
        const ref = db.collection(COLLECTION).doc(id);
        const doc = await ref.get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Pharmacie de garde introuvable.' });
        }

        const current = doc.data().isVisible === true;
        const isVisible = !current;
        await ref.update({
            isVisible,
            dateModification: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.json({ id, isVisible });
    } catch (error) {
        console.error('❌ toggleVisibilite pharmacieGarde :', error.message);
        res.status(500).json({ error: error.message });
    }
};

// DELETE /api/pharmacie-garde/:id
exports.remove = async (req, res) => {
    try {
        const { id } = req.params;
        const ref = db.collection(COLLECTION).doc(id);
        const doc = await ref.get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Pharmacie de garde introuvable.' });
        }
        await ref.delete();
        res.json({ id, deleted: true });
    } catch (error) {
        console.error('❌ remove pharmacieGarde :', error.message);
        res.status(500).json({ error: error.message });
    }
};
