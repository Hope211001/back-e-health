/**
 * etablissementController.js
 *
 * Gestion des établissements de santé enrôlés dans la plateforme.
 *
 * Réservé au SUPERADMIN en écriture : enrôler une structure revient à ouvrir un
 * nouveau périmètre de données, décision qui relève de l'autorité nationale et
 * non d'un administrateur d'hôpital — qui pourrait sinon s'en créer un second
 * et y déplacer des comptes.
 *
 * L'admin garde un accès en LECTURE, restreint à son propre établissement :
 * ses écrans doivent pouvoir en afficher le nom, pas la liste du pays.
 */
const { db, admin } = require('../config/firebase');
const { texteRequis, texteOptionnel } = require('../utils/champs');
const {
    COLLECTION,
    TYPES_ETABLISSEMENT,
    typeEtablissement,
    normaliserId,
    perimetre,
} = require('../services/etablissementService');
const {
    verifierVilleActive,
    chargerReferentielVilles,
    blocVille,
    cleLibelle,
} = require('../services/geoService');

/**
 * Effectifs par établissement, en UNE lecture de `users` pour toute la liste.
 *
 * Une requête `count()` par établissement et par rôle ferait 4 requêtes par
 * ligne affichée ; la collection `users` est de toute façon déjà lue en entier
 * par la recherche d'utilisateurs, c'est la convention du projet.
 */
async function compterEffectifs() {
    const snap = await db.collection('users').get();

    const parEtablissement = new Map();
    snap.forEach((doc) => {
        const data = doc.data();
        const id = normaliserId(data.etablissementId);
        if (!id) return;

        if (!parEtablissement.has(id)) {
            parEtablissement.set(id, { admin: 0, medecin: 0, patient: 0, total: 0 });
        }
        const compteur = parEtablissement.get(id);
        if (compteur[data.role] !== undefined) compteur[data.role]++;
        compteur.total++;
    });
    return parEtablissement;
}

/**
 * GET /api/etablissements?q=&statut=&effectifs=
 * Liste des établissements. Superadmin : tous. Admin : le sien uniquement.
 *
 * Non paginée : une plateforme nationale compte des établissements par
 * centaines, pas par milliers, et les écrans qui s'en servent (sélecteur de
 * rattachement) ont besoin de la liste entière — une troncature silencieuse y
 * empêcherait de choisir certaines structures sans le dire.
 */
exports.listEtablissements = async (req, res) => {
    try {
        const portee = perimetre(req);

        let documents;
        if (portee === null) {
            const snap = await db.collection(COLLECTION).get();
            documents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        } else if (!portee) {
            // Admin non rattaché (compte antérieur au multi-établissement) :
            // liste vide plutôt qu'une erreur, l'écran affiche alors son message
            // « aucun établissement » qui décrit exactement la situation.
            documents = [];
        } else {
            const snap = await db.collection(COLLECTION).doc(portee).get();
            documents = snap.exists ? [{ id: snap.id, ...snap.data() }] : [];
        }

        // Localisation résolue depuis le référentiel, en UNE lecture pour toute
        // la liste : `etablissements` ne stocke que `villeId`, jamais le nom de
        // la ville ni celui de la région.
        const referentiel = await chargerReferentielVilles();
        documents = documents.map((e) => ({ ...e, ville: blocVille(e, referentiel) }));

        // La recherche porte sur la localisation RÉSOLUE : sans ça, chercher
        // « Antananarivo » ne trouverait aucun établissement, le nom de la ville
        // n'étant plus stocké sur le document.
        const q = cleLibelle(req.query.q);
        if (q) {
            documents = documents.filter((e) =>
                cleLibelle([e.nom, e.ville?.nom, e.type].filter(Boolean).join(' ')).includes(q)
            );
        }

        const statut = String(req.query.statut || '').trim();
        if (statut === 'actif' || statut === 'inactif') {
            documents = documents.filter((e) => (e.statut || 'actif') === statut);
        }

        if (req.query.effectifs === 'true' || req.query.effectifs === '1') {
            const effectifs = await compterEffectifs();
            documents = documents.map((e) => ({
                ...e,
                effectifs: effectifs.get(e.id) || { admin: 0, medecin: 0, patient: 0, total: 0 },
            }));
        }

        documents.sort((a, b) => String(a.nom || '').localeCompare(String(b.nom || '')));

        res.json({ data: documents, total: documents.length, types: TYPES_ETABLISSEMENT });
    } catch (error) {
        console.error('Erreur listEtablissements:', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
};

/** GET /api/etablissements/:id */
exports.getEtablissement = async (req, res) => {
    try {
        const { id } = req.params;

        const portee = perimetre(req);
        if (portee !== null && portee !== normaliserId(id)) {
            return res.status(403).json({ error: "Cet établissement n'est pas le vôtre." });
        }

        const snap = await db.collection(COLLECTION).doc(id).get();
        if (!snap.exists) return res.status(404).json({ error: 'Établissement introuvable.' });

        const [effectifs, referentiel] = await Promise.all([
            compterEffectifs(),
            chargerReferentielVilles(),
        ]);
        const data = { id: snap.id, ...snap.data() };
        res.json({
            ...data,
            ville: blocVille(data, referentiel),
            effectifs: effectifs.get(snap.id) || { admin: 0, medecin: 0, patient: 0, total: 0 },
        });
    } catch (error) {
        console.error('Erreur getEtablissement:', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
};

/**
 * POST /api/etablissements
 * Enrôle un établissement dans la plateforme. Superadmin uniquement.
 */
exports.createEtablissement = async (req, res) => {
    try {
        const nom = texteRequis(req.body.nom, "Le nom de l'établissement", 150);
        const type = typeEtablissement(req.body.type);
        const adresse = texteOptionnel(req.body.adresse, "L'adresse", 200);
        const telephone = texteOptionnel(req.body.telephone, 'Le téléphone', 30);
        const email = texteOptionnel(req.body.email, "L'email", 150).toLowerCase();

        // La localisation est une RÉFÉRENCE, pas deux champs texte. La région
        // n'est pas demandée : elle est portée par la ville. C'est ce qui rend
        // désormais impossible d'enregistrer une commune dans une région à
        // laquelle elle n'appartient pas — la base en contenait un cas.
        const ville = await verifierVilleActive(req.body.villeId);

        // Le nom est unique à la ville près : deux « CSB II Ambohipo » dans la
        // même commune ne se distingueraient pas dans un sélecteur, et un compte
        // rattaché au mauvais serait invisible sans que rien ne le signale.
        // Comparaison sur `villeId` et non sur un libellé : deux orthographes de
        // la même ville laissaient passer le doublon.
        const existants = await db.collection(COLLECTION).where('villeId', '==', ville.id).get();
        const doublon = existants.docs.some((d) => cleLibelle(d.data().nom) === cleLibelle(nom));
        if (doublon) {
            return res.status(409).json({
                error: `Un établissement « ${nom} » existe déjà à ${ville.nom}.`,
            });
        }

        const etablissement = {
            nom,
            type,
            villeId: ville.id,
            adresse,
            telephone,
            email,
            statut: 'actif',
            creePar: req.user.uid,
            dateCreation: admin.firestore.FieldValue.serverTimestamp(),
        };

        const ref = await db.collection(COLLECTION).add(etablissement);
        res.status(201).json({
            id: ref.id,
            ...etablissement,
            // Renvoyé pour que l'écran affiche la localisation sans relire le
            // référentiel juste après la création.
            ville: { id: ville.id, nom: ville.nom, statut: ville.statut || 'actif', existe: true },
            dateCreation: new Date(),
        });
    } catch (error) {
        console.error('Erreur createEtablissement:', error.message);
        res.status(error.status || 400).json({ error: error.message });
    }
};

/**
 * PATCH /api/etablissements/:id
 * Superadmin uniquement. Un champ absent n'est pas touché.
 *
 * Le statut n'est pas modifiable ici : il a sa route dédiée, dont les
 * conséquences (plus aucun rattachement possible) méritent une confirmation
 * explicite côté application.
 */
exports.updateEtablissement = async (req, res) => {
    try {
        const { id } = req.params;
        const ref = db.collection(COLLECTION).doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Établissement introuvable.' });

        const modifications = {};
        if (req.body.nom !== undefined) {
            modifications.nom = texteRequis(req.body.nom, "Le nom de l'établissement", 150);
        }
        if (req.body.type !== undefined) modifications.type = typeEtablissement(req.body.type);
        if (req.body.villeId !== undefined) {
            modifications.villeId = (await verifierVilleActive(req.body.villeId)).id;
        }
        if (req.body.adresse !== undefined) {
            modifications.adresse = texteOptionnel(req.body.adresse, "L'adresse", 200);
        }
        if (req.body.telephone !== undefined) {
            modifications.telephone = texteOptionnel(req.body.telephone, 'Le téléphone', 30);
        }
        if (req.body.email !== undefined) {
            modifications.email = texteOptionnel(req.body.email, "L'email", 150).toLowerCase();
        }

        if (Object.keys(modifications).length === 0) {
            return res.json({ id, ...snap.data() });
        }

        modifications.dateModification = admin.firestore.FieldValue.serverTimestamp();
        modifications.modifiePar = req.user.uid;

        await ref.update(modifications);
        res.json({ id, ...snap.data(), ...modifications, dateModification: new Date() });
    } catch (error) {
        console.error('Erreur updateEtablissement:', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
};

/**
 * PATCH /api/etablissements/:id/statut
 * Active ou désactive un établissement. Superadmin uniquement.
 *
 * Pas de suppression : un établissement porte des dossiers médicaux et des
 * ordonnances qui doivent rester consultables même après son retrait de la
 * plateforme. Le désactiver empêche d'y rattacher de nouveaux comptes sans rien
 * effacer — et reste réversible, contrairement à un delete Firestore.
 */
exports.toggleStatutEtablissement = async (req, res) => {
    try {
        const { id } = req.params;
        const ref = db.collection(COLLECTION).doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Établissement introuvable.' });

        const nouveau = (snap.data().statut || 'actif') === 'actif' ? 'inactif' : 'actif';
        await ref.update({
            statut: nouveau,
            dateModification: admin.firestore.FieldValue.serverTimestamp(),
            modifiePar: req.user.uid,
        });

        // Les comptes rattachés ne sont volontairement PAS désactivés en
        // cascade : un établissement retiré de la plateforme n'est pas la même
        // chose qu'un personnel révoqué, et une cascade serait impossible à
        // annuler compte par compte à la réactivation.
        res.json({ id, statut: nouveau });
    } catch (error) {
        console.error('Erreur toggleStatutEtablissement:', error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
};
