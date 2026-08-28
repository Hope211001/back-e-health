/**
 * ocrController.js
 *
 * Résultats d'OCR des affiches de pharmacies de garde (collection "ocr").
 *
 * Champs d'un document :
 *   - pharmacieGardeId : string    lien vers pharamacieGarde/{id}
 *   - idpost           : string    id du post Facebook source (confort de lecture)
 *   - images           : string[]  URLs analysées
 *   - texteBrut        : string    texte intégral lu sur les affiches
 *   - pharmacies       : [{ ville, nom, adresse, telephones[] }]
 *   - nbPharmacies     : number
 *   - nbVilles         : number    villes distinctes détectées sur l'affiche
 *   - modele           : string    modèle OpenRouter ayant réellement répondu
 *   - erreurs          : [{ imageUrl, message }]  images non lues, s'il y en a
 *   - dateCreation     : Timestamp (première analyse)
 *   - dateModification : Timestamp (dernière ré-analyse)
 *
 * L'ID du document EST le pharmacieGardeId : relancer l'OCR écrase l'ancien
 * résultat au lieu d'empiler des doublons, et la lecture par publication est
 * un simple `doc(id).get()` — sans index ni requête.
 */
const { admin, db } = require('../config/firebase');
const { lirePublication } = require('../services/ocrPharmacieGardeService');

const COLLECTION = 'ocr';
const COLLECTION_PHARMACIE = 'pharamacieGarde';

/** Normalise un document Firestore vers l'objet renvoyé au client. */
const mapDoc = (doc) => {
    const data = doc.data() || {};
    return {
        id: doc.id,
        pharmacieGardeId: data.pharmacieGardeId || doc.id,
        idpost: data.idpost || '',
        images: Array.isArray(data.images) ? data.images : [],
        texteBrut: data.texteBrut || '',
        pharmacies: Array.isArray(data.pharmacies) ? data.pharmacies : [],
        nbPharmacies: data.nbPharmacies || 0,
        nbVilles: data.nbVilles || 0,
        modele: data.modele || '',
        erreurs: Array.isArray(data.erreurs) ? data.erreurs : [],
        dateCreation: data.dateCreation || null,
        dateModification: data.dateModification || null,
    };
};

/**
 * POST /api/ocr/pharmacie-garde/:id
 * Lance l'OCR sur les images de la publication et enregistre le résultat.
 */
exports.genererPourPharmacieGarde = async (req, res) => {
    try {
        const { id } = req.params;

        const pharmacieDoc = await db.collection(COLLECTION_PHARMACIE).doc(id).get();
        if (!pharmacieDoc.exists) {
            return res.status(404).json({ error: 'Pharmacie de garde introuvable.' });
        }

        const pharmacieData = pharmacieDoc.data() || {};
        const images = Array.isArray(pharmacieData.attachement) ? pharmacieData.attachement : [];

        // Peut lever une erreur portant un `status` (clé absente, Groq en échec,
        // aucune image…) — reprise telle quelle dans le catch.
        const resultat = await lirePublication(images);

        const ref = db.collection(COLLECTION).doc(id);
        const existant = await ref.get();

        const payload = {
            pharmacieGardeId: id,
            idpost: pharmacieData.idpost || id,
            images: resultat.images,
            texteBrut: resultat.texteBrut,
            pharmacies: resultat.pharmacies,
            nbPharmacies: resultat.pharmacies.length,
            nbVilles: resultat.nbVilles,
            modele: resultat.modele,
            erreurs: resultat.erreurs,
            dateModification: admin.firestore.FieldValue.serverTimestamp(),
            // La date de première analyse est préservée lors d'une ré-analyse.
            dateCreation: existant.exists && existant.data().dateCreation
                ? existant.data().dateCreation
                : admin.firestore.FieldValue.serverTimestamp(),
        };

        await ref.set(payload);
        const enregistre = await ref.get();

        res.status(existant.exists ? 200 : 201).json(mapDoc(enregistre));
    } catch (error) {
        console.error('❌ genererPourPharmacieGarde :', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
};

/**
 * GET /api/ocr/pharmacie-garde/:id
 * Résultat d'OCR déjà enregistré pour une publication (204 si aucun).
 *
 * Ouvert aux patients et médecins, mais uniquement pour les publications
 * visibles : sans ce filtre, un patient pourrait lire l'OCR d'une affiche que
 * l'admin a délibérément masquée, en devinant simplement son identifiant.
 */
exports.getPourPharmacieGarde = async (req, res) => {
    try {
        const { id } = req.params;
        const estAdmin = ['admin', 'superadmin'].includes(req.user?.role);

        if (!estAdmin) {
            const pharmacieDoc = await db.collection(COLLECTION_PHARMACIE).doc(id).get();
            if (!pharmacieDoc.exists || pharmacieDoc.data().isVisible !== true) {
                return res.status(204).send();
            }
        }

        const doc = await db.collection(COLLECTION).doc(id).get();
        if (!doc.exists) return res.status(204).send();
        res.json(mapDoc(doc));
    } catch (error) {
        console.error('❌ getPourPharmacieGarde :', error.message);
        res.status(500).json({ error: error.message });
    }
};

/** GET /api/ocr — tous les résultats, du plus récent au plus ancien. */
exports.getAll = async (req, res) => {
    try {
        const snapshot = await db.collection(COLLECTION).get();
        const list = snapshot.docs.map(mapDoc);

        // Tri en JS plutôt que via orderBy : évite d'exiger un index sur une
        // collection qui restera petite.
        const instant = (d) => d.dateModification?._seconds ?? d.dateModification?.seconds ?? 0;
        list.sort((a, b) => instant(b) - instant(a));

        res.json(list);
    } catch (error) {
        console.error('❌ getAll ocr :', error.message);
        res.status(500).json({ error: error.message });
    }
};

/** DELETE /api/ocr/pharmacie-garde/:id */
exports.remove = async (req, res) => {
    try {
        const { id } = req.params;
        const ref = db.collection(COLLECTION).doc(id);
        const doc = await ref.get();
        if (!doc.exists) return res.status(404).json({ error: 'Résultat OCR introuvable.' });
        await ref.delete();
        res.json({ id, deleted: true });
    } catch (error) {
        console.error('❌ remove ocr :', error.message);
        res.status(500).json({ error: error.message });
    }
};
