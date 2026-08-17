/**
 * geoController.js
 *
 * Référentiel des villes et communes.
 *
 * ÉCRITURE réservée au superadmin : le référentiel est national, et laisser
 * chaque administrateur y ajouter librement des communes ramènerait le problème
 * qu'on cherche à supprimer — trois orthographes de la même ville, enrôlées par
 * trois établissements différents.
 *
 * LECTURE ouverte à tous les rôles authentifiés : un médecin qui enregistre un
 * patient doit pouvoir choisir sa ville, et un patient doit pouvoir corriger la
 * sienne depuis son profil.
 */
const { db, admin } = require('../config/firebase');
const { texteRequis } = require('../utils/champs');
const {
    COLLECTION_VILLES,
    cleLibelle,
    chargerReferentielVilles,
} = require('../services/geoService');

/**
 * GET /api/villes?q=&statut=
 * Liste des villes.
 *
 * Non paginée : le référentiel reste petit par nature, et les sélecteurs ont
 * besoin de la liste entière — une troncature silencieuse empêcherait de
 * choisir certaines communes sans le dire.
 */
exports.listVilles = async (req, res) => {
    try {
        const referentiel = await chargerReferentielVilles();
        let villes = [...referentiel.values()];

        const statut = String(req.query.statut || '').trim();
        if (statut === 'actif' || statut === 'inactif') {
            villes = villes.filter((v) => (v.statut || 'actif') === statut);
        }

        // Recherche insensible à la casse ET aux accents : « Ambohipo » doit
        // être trouvé aussi bien par « ambohipo » que par « AMBOHIPO ».
        const q = cleLibelle(req.query.q);
        if (q) villes = villes.filter((v) => cleLibelle(v.nom).includes(q));

        villes.sort((a, b) => String(a.nom || '').localeCompare(String(b.nom || '')));
        res.json({ data: villes, total: villes.length });
    } catch (error) {
        console.error('Erreur listVilles:', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
};

/** POST /api/villes — superadmin. */
exports.createVille = async (req, res) => {
    try {
        const nom = texteRequis(req.body.nom, 'Le nom de la ville', 100);

        // Unicité sur le libellé NORMALISÉ, et non sur la chaîne brute : c'est
        // tout l'intérêt d'être sorti du texte libre. Sans cette comparaison,
        // « Antananarivo » et « antananarivo » deviendraient deux villes.
        const snap = await db.collection(COLLECTION_VILLES).get();
        const cle = cleLibelle(nom);
        if (snap.docs.some((d) => cleLibelle(d.data().nom) === cle)) {
            return res.status(409).json({ error: `La ville « ${nom} » existe déjà.` });
        }

        const ville = {
            nom,
            statut: 'actif',
            creePar: req.user.uid,
            dateCreation: admin.firestore.FieldValue.serverTimestamp(),
        };

        const ref = await db.collection(COLLECTION_VILLES).add(ville);
        res.status(201).json({ id: ref.id, ...ville, dateCreation: new Date() });
    } catch (error) {
        console.error('Erreur createVille:', error.message);
        res.status(error.status || 400).json({ error: error.message });
    }
};

/**
 * PATCH /api/villes/:id — superadmin. Renommage.
 *
 * C'est ici que la normalisation montre sa valeur : corriger l'orthographe
 * d'une commune ne demande de modifier qu'un seul document, et tous les
 * établissements comme tous les comptes qui la référencent affichent la
 * correction immédiatement, sans migration.
 */
exports.updateVille = async (req, res) => {
    try {
        const { id } = req.params;
        const ref = db.collection(COLLECTION_VILLES).doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Ville introuvable.' });

        if (req.body.nom === undefined) return res.json({ id, ...snap.data() });
        const nom = texteRequis(req.body.nom, 'Le nom de la ville', 100);

        // Contrôle d'unicité sur la valeur finale : un renommage peut créer un
        // doublon là où il n'y en avait pas.
        const voisines = await db.collection(COLLECTION_VILLES).get();
        const cle = cleLibelle(nom);
        if (voisines.docs.some((d) => d.id !== id && cleLibelle(d.data().nom) === cle)) {
            return res.status(409).json({ error: `Une ville « ${nom} » existe déjà.` });
        }

        // L'identifiant du document n'est jamais recalculé : il est référencé
        // par les établissements et les comptes, le changer les détacherait
        // tous. C'est le principe même du schéma normalisé — le libellé bouge,
        // la clé ne bouge pas.
        await ref.update({
            nom,
            dateModification: admin.firestore.FieldValue.serverTimestamp(),
            modifiePar: req.user.uid,
        });
        res.json({ id, ...snap.data(), nom });
    } catch (error) {
        console.error('Erreur updateVille:', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
};

/**
 * PATCH /api/villes/:id/statut — superadmin.
 *
 * Pas de suppression : une ville est référencée par des établissements et des
 * comptes. La supprimer laisserait des références mortes, sans retour en
 * arrière possible. Désactivée, elle n'accepte plus de nouveau rattachement
 * sans que rien ne soit effacé.
 */
exports.toggleStatutVille = async (req, res) => {
    try {
        const { id } = req.params;
        const ref = db.collection(COLLECTION_VILLES).doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Ville introuvable.' });

        const nouveau = (snap.data().statut || 'actif') === 'actif' ? 'inactif' : 'actif';
        await ref.update({
            statut: nouveau,
            dateModification: admin.firestore.FieldValue.serverTimestamp(),
            modifiePar: req.user.uid,
        });
        res.json({ id, statut: nouveau });
    } catch (error) {
        console.error('Erreur toggleStatutVille:', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
};
