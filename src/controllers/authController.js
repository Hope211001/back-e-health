const crypto = require('crypto');
const { db, auth, admin } = require('../config/firebase');
const { resoudrePhoto } = require('../services/cloudinaryService');
const { envoyerIdentifiants, envoyerLienReset } = require('../services/mailService');

// --- HELPERS ---

/** Rôles qu'un superadmin peut créer via /register-admin. */
const ROLES_ADMINISTRATION = ['admin', 'superadmin'];

/** Sous-collection de détail associée à un rôle, quand il en a une. */
const COLLECTION_DETAIL = { medecin: 'medecins', patient: 'patients' };

/**
 * Trace du compte à l'origine d'une création : « ce médecin a été créé par tel
 * admin », « ce patient par tel médecin ».
 *
 * Le RÔLE est figé au moment de la création — c'est un fait historique qui
 * reste vrai même si le créateur est promu ou rétrogradé ensuite. Le NOM, lui,
 * n'est volontairement pas recopié : il serait faux dès que le créateur
 * corrige son état civil. Il est résolu à la lecture depuis `creePar`
 * (voir resoudreCreateurs).
 */
function infosCreateur(req) {
    return {
        creePar: req.user?.uid || null,
        creeParRole: req.user?.role || null,
    };
}

/**
 * Valide un champ texte obligatoire et renvoie sa version nettoyée.
 *
 * Une suite d'espaces n'est pas une valeur : sans ce contrôle, un `nom` fait
 * de blancs passait les validations de longueur côté client comme côté
 * Firestore, et le compte se retrouvait affiché par son email partout.
 * Les espaces internes multiples sont réduits à un seul, pour que « Jean   Luc »
 * et « Jean Luc » ne soient pas deux valeurs différentes dans les tris.
 */
function texteRequis(valeur, libelle, max = 100) {
    const propre = String(valeur ?? '').trim().replace(/\s+/g, ' ');
    if (!propre) {
        const err = new Error(`${libelle} est obligatoire.`);
        err.status = 400;
        throw err;
    }
    if (propre.length > max) {
        const err = new Error(`${libelle} ne doit pas dépasser ${max} caractères.`);
        err.status = 400;
        throw err;
    }
    return propre;
}

/** Email normalisé (minuscules, sans espaces autour) et vérifié. */
function emailRequis(valeur) {
    const propre = String(valeur ?? '').trim().toLowerCase();
    if (!propre) {
        const err = new Error("L'adresse email est obligatoire.");
        err.status = 400;
        throw err;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(propre)) {
        const err = new Error("Adresse email invalide.");
        err.status = 400;
        throw err;
    }
    return propre;
}

/**
 * Mot de passe : refuse le vide et les mots de passe composés d'espaces.
 * Le minimum de 6 est celui de Firebase Auth ; les écrans en exigent 8, cette
 * borne n'est là que pour rendre le message d'erreur lisible en français
 * plutôt que de laisser remonter celui du SDK.
 */
function motDePasseRequis(valeur) {
    const brut = String(valeur ?? '');
    if (!brut.trim()) {
        const err = new Error("Le mot de passe est obligatoire.");
        err.status = 400;
        throw err;
    }
    if (brut.length < 6) {
        const err = new Error("Le mot de passe doit faire au moins 6 caractères.");
        err.status = 400;
        throw err;
    }
    return brut;
}

/**
 * Préfixe du mot de passe généré, par rôle. Purement cosmétique : il rend le
 * mot de passe reconnaissable dans l'email et ne compte pas comme du secret.
 */
const PREFIXE_MOT_DE_PASSE = {
    patient: 'PAT',
    medecin: 'MED',
    admin: 'ADM',
    superadmin: 'SUP',
};

/**
 * Mot de passe d'un compte créé par un tiers : préfixe de rôle + 8 chiffres,
 * par exemple « PAT48190573 ».
 *
 * Ce n'est PAS un code provisoire : son titulaire peut le garder indéfiniment.
 * Il lui est simplement proposé de le remplacer à sa première connexion (voir
 * `proposerChangementMotDePasse`), proposition qu'il est libre de décliner.
 *
 * Format numérique après le préfixe parce qu'il est lu dans un email puis
 * recopié à la main sur un téléphone : un mot de passe mélangé impose trois
 * bascules de clavier et la confusion entre l, I et 1. Un compte auquel
 * personne n'arrive à se connecter ne sert à rien.
 *
 * 8 chiffres et non 6 : le mot de passe étant destiné à durer, 900 000
 * combinaisons seraient devinables par essais automatisés. 8 chiffres en
 * donnent 100 millions — cent fois plus, pour deux touches de plus et sans
 * rien perdre du confort de saisie au pavé numérique.
 *
 * Le tirage commence à 10000000 pour que le mot de passe fasse toujours
 * exactement 8 chiffres : un zéro de tête passerait pour décoratif et serait
 * omis à la saisie.
 *
 * `crypto.randomInt` et non `Math.random` : ce dernier n'est pas
 * cryptographiquement sûr et sa suite se prédit à partir de quelques tirages,
 * ce qui permettrait de deviner le mot de passe suivant à partir du précédent.
 */
function genererMotDePasse(role) {
    const prefixe = PREFIXE_MOT_DE_PASSE[role] || 'MED';
    return `${prefixe}${crypto.randomInt(10000000, 100000000)}`;
}

/**
 * Mot de passe à utiliser pour un compte en cours de création.
 *
 * Le cas normal est l'ABSENCE de `password` dans la requête : les écrans de
 * création ne le demandent plus, le serveur en génère un et l'envoie par email
 * au titulaire. Celui qui crée le compte ne le connaît donc jamais.
 *
 * Un `password` fourni reste accepté et validé, pour les outils qui créent un
 * compte hors application (scripts/create-superadmin.js, tests manuels).
 */
function motDePasseDuNouveauCompte(valeur, role) {
    if (valeur === undefined || valeur === null || String(valeur) === '') {
        return genererMotDePasse(role);
    }
    return motDePasseRequis(valeur);
}

/**
 * Sexe normalisé : 'M', 'F' ou '' (non renseigné).
 *
 * Facultatif à dessein — c'est une donnée personnelle dont ni la connexion ni
 * les ordonnances ne dépendent, l'exiger bloquerait une création de compte pour
 * rien. En revanche une valeur fournie doit être exploitable : les dossiers
 * affichent « Masculin » / « Féminin » à partir de cette lettre exactement, et
 * un 'Homme' ou un 'm ' passerait pour non renseigné.
 */
function sexeOptionnel(valeur) {
    if (valeur === undefined || valeur === null) return '';
    const propre = String(valeur).trim().toUpperCase();
    if (!propre) return '';
    if (propre !== 'M' && propre !== 'F') {
        const err = new Error("Sexe invalide : 'M' ou 'F' attendu.");
        err.status = 400;
        throw err;
    }
    return propre;
}

/** Âge au-delà duquel une date de naissance est forcément une faute de saisie. */
const AGE_MAX = 130;

/**
 * Date de naissance normalisée en 'AAAA-MM-JJ', ou '' (non renseignée).
 *
 * Stockée en CHAÎNE et non en Timestamp : une date de naissance est une date
 * civile, pas un instant. Un Timestamp est un point précis dans le temps, qui
 * relu depuis un autre fuseau recule d'un jour — quelqu'un né le 1er du mois
 * s'afficherait né le dernier jour du mois précédent, et son âge changerait de
 * valeur au passage d'un anniversaire selon le téléphone qui le consulte.
 *
 * Facultative, comme le sexe et l'adresse : l'exiger bloquerait la création
 * d'un compte pour une donnée dont ni la connexion ni les ordonnances ne
 * dépendent. Mais une valeur fournie doit être exploitable, puisque c'est
 * l'âge affiché qui en est calculé.
 */
function dateNaissanceOptionnelle(valeur) {
    if (valeur === undefined || valeur === null) return '';
    const propre = String(valeur).trim();
    if (!propre) return '';

    const refuser = (message) => {
        const err = new Error(message);
        err.status = 400;
        throw err;
    };

    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(propre);
    if (!parts) refuser("Date de naissance invalide : format attendu AAAA-MM-JJ.");

    const [, annee, mois, jour] = parts.map(Number);
    const date = new Date(Date.UTC(annee, mois - 1, jour));

    // Contrôle des trois composantes après coup : `Date` ne rejette pas un 31
    // février, il le décale silencieusement au 3 mars. Sans cette relecture, une
    // date inexistante serait acceptée puis réaffichée changée.
    if (date.getUTCFullYear() !== annee
        || date.getUTCMonth() !== mois - 1
        || date.getUTCDate() !== jour) {
        refuser("Date de naissance invalide : ce jour n'existe pas.");
    }

    const maintenant = new Date();
    if (date.getTime() > maintenant.getTime()) {
        refuser("La date de naissance ne peut pas être dans le futur.");
    }
    if (annee < maintenant.getUTCFullYear() - AGE_MAX) {
        refuser(`Date de naissance invalide : plus de ${AGE_MAX} ans.`);
    }

    return propre;
}

/** Texte facultatif nettoyé, avec longueur maximale (adresse, notes…). */
function texteOptionnel(valeur, libelle, max = 200) {
    if (valeur === undefined || valeur === null) return '';
    const propre = String(valeur).trim().replace(/\s+/g, ' ');
    if (propre.length > max) {
        const err = new Error(`${libelle} ne doit pas dépasser ${max} caractères.`);
        err.status = 400;
        throw err;
    }
    return propre;
}

/** Identité affichable d'un compte, avec repli sur l'email. */
function identiteCompte(data) {
    if (!data) return '';
    return `${data.prenom || ''} ${data.nom || ''}`.trim() || data.email || '';
}

/**
 * Résout l'identité des créateurs d'un lot de comptes en UNE seule requête
 * (`getAll`), plutôt qu'une lecture par ligne affichée.
 *
 * Renvoie une Map uid → { uid, identite, role }.
 */
async function resoudreCreateurs(utilisateurs) {
    const uids = [...new Set(utilisateurs.map((u) => u.creePar).filter(Boolean))];
    if (uids.length === 0) return new Map();

    const snaps = await db.getAll(...uids.map((uid) => db.collection('users').doc(uid)));

    const parUid = new Map();
    for (const snap of snaps) {
        if (!snap.exists) continue;
        const data = snap.data();
        parUid.set(snap.id, {
            uid: snap.id,
            identite: identiteCompte(data),
            role: data.role || null,
        });
    }
    return parUid;
}

/**
 * Bloc « créé par » exposé au client, tolérant aux comptes antérieurs à cette
 * traçabilité (`creePar` absent) et aux créateurs supprimés depuis.
 */
function blocCreateur(utilisateur, createurs) {
    if (!utilisateur.creePar) return null;
    const trouve = createurs.get(utilisateur.creePar);
    return {
        uid: utilisateur.creePar,
        // Le rôle figé dans le document prime : il décrit le créateur AU MOMENT
        // de la création, alors que `trouve.role` est son rôle actuel.
        role: utilisateur.creeParRole || trouve?.role || null,
        identite: trouve?.identite || '',
        // Faux quand le compte créateur a été supprimé depuis.
        existe: Boolean(trouve),
    };
}

/**
 * Téléverse la photo d'un compte qui vient d'être créé.
 *
 * Si l'upload échoue, le compte Firebase Auth est supprimé : sans ça, l'email
 * resterait pris par un compte sans document Firestore, impossible à recréer
 * comme à utiliser.
 */
async function photoDuNouveauCompte(photo, uid) {
    if (photo === undefined || photo === null || String(photo).trim() === '') return '';
    try {
        return await resoudrePhoto(photo, uid);
    } catch (error) {
        await admin.auth().deleteUser(uid).catch((e) =>
            console.error(`⚠️  Compte Auth ${uid} orphelin après échec photo :`, e.message)
        );
        throw error;
    }
}

/** Nom du créateur, pour l'email d'identifiants (« créé par Dr Rakoto »). */
async function identiteDuCreateur(req) {
    if (!req.user?.uid) return '';
    try {
        const snap = await db.collection('users').doc(req.user.uid).get();
        return snap.exists ? identiteCompte(snap.data()) : '';
    } catch {
        // Un créateur non résolu ne justifie pas de priver l'utilisateur de
        // ses identifiants : le mail part sans la mention « par ... ».
        return '';
    }
}

/**
 * Envoie ses identifiants au titulaire d'un compte tout juste créé.
 *
 * Appelé APRÈS le commit Firestore, et ne lève jamais : contrairement à
 * l'upload de photo — qui, en échouant, laisserait un compte Auth sans
 * document et un email définitivement pris — un SMTP en panne ne rend le
 * compte ni invalide ni inutilisable. L'annuler pour autant ferait dépendre la
 * création d'utilisateurs de la disponibilité d'un serveur de courrier.
 *
 * Le résultat est tracé sur `users/{uid}.identifiantsEnvoyes`, ce qui permet à
 * l'administration de repérer les envois manqués et de les relancer via
 * POST /auth/users/:uid/renvoyer-identifiants.
 */
async function notifierIdentifiants({ req, uid, email, nom, prenom, role, motDePasse }) {
    try {
        const createur = await identiteDuCreateur(req);
        await envoyerIdentifiants({ email, nom, prenom, role, motDePasse, createur });
        await db.collection('users').doc(uid).update({
            identifiantsEnvoyes: true,
            identifiantsEnvoyesLe: admin.firestore.FieldValue.serverTimestamp(),
        });
        return true;
    } catch (error) {
        // Le mot de passe n'apparaît volontairement pas dans ce log : il ne
        // doit exister que dans l'email et dans Firebase Auth.
        console.error(`⚠️  Identifiants non envoyés à ${email} :`, error.message);
        await db.collection('users').doc(uid)
            .update({ identifiantsEnvoyes: false })
            .catch(() => { });
        return false;
    }
}

function formatTelephoneMalgache(tel) {
    let cleanTel = (tel || '').trim().replace(/[\s\-\.\(\)]/g, '');
    const hadPlus = cleanTel.startsWith('+');
    cleanTel = cleanTel.replace(/[^0-9]/g, '');
    if (cleanTel.startsWith('0')) cleanTel = cleanTel.substring(1);
    const formatted = hadPlus ? `+${cleanTel}` : `+261${cleanTel}`;
    const digits = formatted.replace(/\D/g, '');
    if (digits.length < 11 || digits.length > 15) {
        const err = new Error("Numéro de téléphone invalide. Format attendu : 034 XX XXX XX");
        err.status = 400;
        throw err;
    }
    return formatted;
}

// --- REGISTER PATIENT (par son médecin traitant, ou par l'administration) ---
exports.registerPatient = async (req, res) => {
    try {
        const { tel, photo } = req.body;
        const email = emailRequis(req.body.email);
        const motDePasse = motDePasseDuNouveauCompte(req.body.password, 'patient');
        const nom = texteRequis(req.body.nom, 'Le nom');
        const prenom = texteRequis(req.body.prenom, 'Le prénom');
        const sexe = sexeOptionnel(req.body.sexe);
        const adresse = texteOptionnel(req.body.adresse, "L'adresse");
        const dateNaissance = dateNaissanceOptionnelle(req.body.dateNaissance);

        // Un médecin s'attribue automatiquement le patient. Un admin, lui, doit
        // désigner le médecin traitant : le déduire de son propre token
        // rattacherait le patient à un compte admin, ce qui n'a aucun sens
        // métier et casserait les écrans « mes patients » côté médecin.
        let medecinId = req.user.uid;
        if (req.user.role !== 'medecin') {
            medecinId = (req.body.medecinId || '').trim();
            if (!medecinId) {
                return res.status(400).json({
                    error: "Le médecin traitant est requis (champ 'medecinId').",
                });
            }
            const medecinSnap = await db.collection('users').doc(medecinId).get();
            if (!medecinSnap.exists || medecinSnap.data().role !== 'medecin') {
                return res.status(400).json({ error: "Le médecin traitant indiqué est introuvable." });
            }
        }

        const formattedTel = formatTelephoneMalgache(tel);

        const userRecord = await admin.auth().createUser({
            email,
            password: motDePasse,
            phoneNumber: formattedTel
        });

        const uid = userRecord.uid;
        const photoURL = await photoDuNouveauCompte(photo, uid);
        const batch = db.batch();

        const userRef = db.collection('users').doc(uid);
        const userBase = {
            uid,
            email,
            role: 'patient',
            nom,
            prenom,
            sexe,
            dateNaissance,
            adresse,
            photoURL,
            telephone: formattedTel,
            statut: 'actif',
            authProvider: 'password',
            // Le compte n'a pas choisi son mot de passe, il l'a reçu par email.
            // L'application lui proposera d'en définir un à sa première
            // connexion ; le drapeau retombe à false qu'il accepte OU qu'il
            // refuse, pour ne pas reposer la question à chaque ouverture.
            proposerChangementMotDePasse: true,
            // Traçabilité : un patient est créé soit par son médecin traitant,
            // soit par l'administration — `medecinTraitantId` seul ne permet
            // pas de distinguer les deux cas.
            ...infosCreateur(req),
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        const patientRef = db.collection('patients').doc(uid);
        const patientDetail = {
            id: uid,
            userId: uid,
            email,
            nom,
            prenom,
            sexe,
            dateNaissance,
            adresse,
            photoURL,
            telephone: formattedTel,
            ...infosCreateur(req),
            numeroPatient: `PAT-${Date.now().toString().slice(-4)}`,
            medecinTraitantId: medecinId,
            allergies: [],
            antecedents: [],
            statut: 'actif',
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        batch.set(userRef, userBase);
        batch.set(patientRef, patientDetail);
        await batch.commit();

        const emailEnvoye = await notifierIdentifiants({
            req, uid, email, nom, prenom, role: 'patient', motDePasse,
        });

        res.status(201).json({ ...patientDetail, emailEnvoye });
    } catch (error) {
        console.error("Erreur registerPatient:", error.message);
        res.status(error.status || 400).json({ error: error.message });
    }
};

// --- REGISTER MEDECIN (par admin ou superadmin) ---
exports.registerMedecin = async (req, res) => {
    try {
        const { tel, spec, ordre, photo } = req.body;
        const email = emailRequis(req.body.email);
        const motDePasse = motDePasseDuNouveauCompte(req.body.password, 'medecin');
        const nom = texteRequis(req.body.nom, 'Le nom');
        const prenom = texteRequis(req.body.prenom, 'Le prénom');
        const numeroOrdre = texteRequis(ordre, "Le numéro d'ordre", 50);
        const sexe = sexeOptionnel(req.body.sexe);
        const adresse = texteOptionnel(req.body.adresse, "L'adresse");
        const dateNaissance = dateNaissanceOptionnelle(req.body.dateNaissance);

        const userRecord = await auth.createUser({ email, password: motDePasse });
        const uid = userRecord.uid;
        const photoURL = await photoDuNouveauCompte(photo, uid);
        const batch = db.batch();

        // `medecinDetail` reprend ces champs par étalement : l'état civil et la
        // photo se retrouvent donc aussi dans `medecins/{uid}`, que les écrans
        // médecin lisent directement.
        const userBase = {
            uid,
            email,
            role: 'medecin',
            nom,
            prenom,
            sexe,
            dateNaissance,
            adresse,
            photoURL,
            telephone: tel || '',
            statut: 'actif',
            authProvider: 'password',
            proposerChangementMotDePasse: true,
            ...infosCreateur(req),
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        const medecinDetail = {
            ...userBase,
            id: uid,
            userId: uid,
            // Les spécialités vides sont écartées : une liste [""] afficherait
            // une puce sans libellé dans le dossier du médecin.
            specialite: (Array.isArray(spec) ? spec : (spec ? [spec] : []))
                .map((s) => String(s).trim())
                .filter(Boolean),
            numeroOrdre,
        };

        batch.set(db.collection('users').doc(uid), userBase);
        batch.set(db.collection('medecins').doc(uid), medecinDetail);
        await batch.commit();

        const emailEnvoye = await notifierIdentifiants({
            req, uid, email, nom, prenom, role: 'medecin', motDePasse,
        });

        res.status(201).json({ ...medecinDetail, emailEnvoye });
    } catch (error) {
        console.error("Erreur registration médecin:", error.message);
        res.status(400).json({ error: error.message });
    }
};

// --- REGISTER ADMIN ou SUPERADMIN (superadmin uniquement) ---
//
// Le rôle est un paramètre et non plus une constante : un superadmin doit
// pouvoir se donner un successeur ou un pair depuis l'application. Le script
// scripts/create-superadmin.js ne sert qu'à l'amorçage du tout premier compte,
// quand personne n'est encore connecté pour appeler cette route.
exports.registerAdmin = async (req, res) => {
    try {
        const { tel, photo } = req.body;
        const email = emailRequis(req.body.email);
        const nom = texteRequis(req.body.nom, 'Le nom');
        const prenom = texteRequis(req.body.prenom, 'Le prénom');
        const sexe = sexeOptionnel(req.body.sexe);
        const adresse = texteOptionnel(req.body.adresse, "L'adresse");
        const dateNaissance = dateNaissanceOptionnelle(req.body.dateNaissance);

        const role = String(req.body.role || 'admin').trim();
        if (!ROLES_ADMINISTRATION.includes(role)) {
            return res.status(400).json({
                error: `Rôle invalide : attendu ${ROLES_ADMINISTRATION.join(' ou ')}.`,
            });
        }

        // Après la validation du rôle : le préfixe du code temporaire en dépend.
        const motDePasse = motDePasseDuNouveauCompte(req.body.password, role);

        const userRecord = await auth.createUser({ email, password: motDePasse });
        const uid = userRecord.uid;
        const photoURL = await photoDuNouveauCompte(photo, uid);

        const userBase = {
            uid,
            email,
            role,
            nom,
            prenom,
            sexe,
            dateNaissance,
            adresse,
            photoURL,
            telephone: tel || '',
            statut: 'actif',
            authProvider: 'password',
            proposerChangementMotDePasse: true,
            ...infosCreateur(req),
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        await db.collection('users').doc(uid).set(userBase);

        const emailEnvoye = await notifierIdentifiants({
            req, uid, email, nom, prenom, role, motDePasse,
        });

        res.status(201).json({ ...userBase, emailEnvoye });
    } catch (error) {
        console.error("Erreur registration admin:", error.message);
        res.status(400).json({ error: error.message });
    }
};

// --- LOGIN classique (email/password déjà vérifié côté client) ---
exports.login = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: "Token manquant" });
        }
        const token = authHeader.split(' ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;

        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: "Profil utilisateur inexistant. Demandez à un administrateur de créer votre compte." });
        }

        const userData = userDoc.data();
        if (userData.statut === 'inactif') {
            return res.status(403).json({ error: "Compte désactivé. Contactez un administrateur." });
        }

        res.json({ uid, ...userData });
    } catch (error) {
        console.error("Erreur login:", error.message);
        res.status(401).json({ error: "Session non autorisée" });
    }
};

// --- GOOGLE SIGN-IN ---
// Premier login Google => crée un profil patient par défaut si inexistant.
// Les comptes medecin/admin/superadmin doivent être créés AVANT par un admin
// (sinon l'utilisateur Google sera créé en 'patient' par défaut).
exports.googleSignIn = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: "Token Google manquant" });
        }
        const token = authHeader.split(' ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;
        const email = decodedToken.email;
        const name = decodedToken.name || '';
        const picture = decodedToken.picture || '';

        const userRef = db.collection('users').doc(uid);
        const userSnap = await userRef.get();

        if (userSnap.exists) {
            const userData = userSnap.data();
            if (userData.statut === 'inactif') {
                return res.status(403).json({ error: "Compte désactivé. Contactez un administrateur." });
            }
            // Met à jour la photo / nom si vide
            const updates = {};
            if (!userData.photoURL && picture) updates.photoURL = picture;
            if (!userData.nom && name) updates.nom = name;
            if (Object.keys(updates).length) await userRef.update(updates);

            return res.json({ uid, ...userData, ...updates });
        }

        // Aucun document pour cet uid. Avant de créer un profil, vérifier qu'un
        // compte ne porte pas déjà cette adresse sous un AUTRE uid : ce serait
        // un compte créé par l'administration (médecin, admin…) dont Firebase
        // n'a pas fusionné les providers. Le laisser passer créerait un second
        // compte, patient par défaut — un médecin perdrait son rôle et ses
        // patients en se connectant simplement avec Google.
        const homonymes = await db.collection('users').where('email', '==', email).limit(1).get();
        if (!homonymes.empty) {
            console.error(
                `⚠️  Google Sign-In : ${email} existe déjà sous l'uid ${homonymes.docs[0].id}, `
                + `mais Firebase a émis l'uid ${uid}. Vérifier « one account per email address » `
                + `dans la console Firebase (Authentication → Settings).`
            );
            return res.status(409).json({
                error: "Un compte existe déjà avec cette adresse email. "
                    + "Connectez-vous avec votre mot de passe, ou contactez un administrateur.",
            });
        }

        // Création automatique d'un profil patient par défaut
        const [prenom, ...rest] = name.split(' ');
        const userBase = {
            uid,
            email,
            role: 'patient',
            nom: rest.join(' ') || '',
            prenom: prenom || '',
            photoURL: picture,
            telephone: '',
            statut: 'actif',
            authProvider: 'google',
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        const patientDetail = {
            id: uid,
            userId: uid,
            email,
            // Recopiés depuis le profil Google : sans ça, le document patient
            // resterait anonyme alors que `users` connaît déjà l'identité.
            nom: userBase.nom,
            prenom: userBase.prenom,
            photoURL: picture || '',
            numeroPatient: `PAT-${Date.now().toString().slice(-4)}`,
            medecinTraitantId: null,
            allergies: [],
            antecedents: [],
            statut: 'actif',
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        };

        const batch = db.batch();
        batch.set(userRef, userBase);
        batch.set(db.collection('patients').doc(uid), patientDetail);
        await batch.commit();

        res.status(201).json({ uid, ...userBase });
    } catch (error) {
        console.error("Erreur Google Sign-In:", error.message);
        res.status(401).json({ error: "Échec authentification Google" });
    }
};

// --- FORGOT PASSWORD ---
// Génère un lien de réinitialisation Firebase et le renvoie.
// Le front peut l'envoyer par email (ou Firebase Auth envoie directement avec sendPasswordResetEmail côté client).
exports.forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Email requis" });

        try {
            await admin.auth().getUserByEmail(email);
        } catch {
            // On répond toujours 200 pour ne pas révéler si l'email existe
            return res.json({ message: "Si cet email existe, un lien a été envoyé." });
        }

        // Firebase reste maître du mot de passe : il produit le lien à usage
        // unique. Nodemailer ne fait que l'acheminer — le service d'envoi
        // intégré à Firebase impose son quota, son expéditeur et son gabarit.
        const link = await admin.auth().generatePasswordResetLink(email);

        try {
            await envoyerLienReset({ email, lien: link });
        } catch (erreurMail) {
            // On garde la réponse indifférenciée côté client — signaler l'échec
            // révélerait que l'adresse existe — mais l'incident doit rester
            // visible dans les logs du serveur.
            console.error(`⚠️  Lien de réinitialisation non envoyé à ${email} :`, erreurMail.message);
        }

        res.json({ message: "Si cet email existe, un lien a été envoyé." });
    } catch (error) {
        console.error("Erreur forgotPassword:", error.message);
        res.status(500).json({ error: "Erreur lors de la génération du lien" });
    }
};

// --- PROFILE ---
exports.getUserProfile = async (req, res) => {
    try {
        const uid = req.params.uid;
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ error: "Utilisateur non trouvé" });

        const data = userDoc.data();
        const createurs = await resoudreCreateurs([data]);
        res.json({ ...data, createur: blocCreateur(data, createurs) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * PATCH /api/auth/profile/:uid
 * Mise à jour de l'état civil, du téléphone et de la photo de profil.
 *
 * Qui peut modifier qui :
 *   - tout le monde son propre compte ;
 *   - le superadmin, n'importe quel compte ;
 *   - l'admin, les comptes médecin et patient uniquement — laisser un admin
 *     éditer un pair ou un superadmin lui donnerait de fait le pouvoir de
 *     s'attribuer leur identité, alors que la hiérarchie des rôles ne descend
 *     que vers le bas.
 *
 * Le rôle et le statut ne sont volontairement pas modifiables ici : le premier
 * n'est pas censé changer après création, le second a sa route dédiée qui
 * révoque en plus les sessions en cours.
 */
exports.updateUserProfile = async (req, res) => {
    try {
        const { uid } = req.params;
        const { nom, prenom, tel, photo, sexe, adresse, dateNaissance } = req.body;

        const userRef = db.collection('users').doc(uid);
        const snap = await userRef.get();
        if (!snap.exists) return res.status(404).json({ error: "Utilisateur non trouvé" });

        const cible = snap.data();
        const soiMeme = req.user.uid === uid;
        const autorise = soiMeme
            || req.user.role === 'superadmin'
            || (req.user.role === 'admin' && ['medecin', 'patient'].includes(cible.role));

        if (!autorise) {
            return res.status(403).json({ error: "Vous n'avez pas le droit de modifier ce profil." });
        }

        // Un champ absent n'est pas touché ; un champ présent doit être valide.
        // Autoriser le vide ici reviendrait à offrir un moyen d'effacer l'état
        // civil que les écrans de création interdisent justement.
        const modifications = {};
        if (nom !== undefined) modifications.nom = texteRequis(nom, 'Le nom');
        if (prenom !== undefined) modifications.prenom = texteRequis(prenom, 'Le prénom');
        if (tel !== undefined) {
            // Vide accepté : le téléphone n'est pas obligatoire sur tous les rôles.
            modifications.telephone = String(tel).trim()
                ? formatTelephoneMalgache(tel)
                : '';
        }
        // Sexe, date de naissance et adresse restent facultatifs après création,
        // y compris pour les effacer : contrairement à l'état civil, ce sont des
        // données qu'un utilisateur peut légitimement vouloir retirer de son
        // profil.
        if (sexe !== undefined) modifications.sexe = sexeOptionnel(sexe);
        if (adresse !== undefined) modifications.adresse = texteOptionnel(adresse, "L'adresse");
        if (dateNaissance !== undefined) {
            modifications.dateNaissance = dateNaissanceOptionnelle(dateNaissance);
        }

        // Fait en dernier : un échec d'upload ne doit pas laisser un profil à
        // moitié enregistré (nom modifié, photo non).
        const photoURL = await resoudrePhoto(photo, uid);
        if (photoURL !== undefined) modifications.photoURL = photoURL;

        if (Object.keys(modifications).length === 0) {
            return res.json({ uid, ...cible });
        }

        const batch = db.batch();
        batch.update(userRef, modifications);

        // Le document de détail duplique l'état civil : sans cette recopie, les
        // écrans qui le lisent (tableaux de bord médecin et patient, dossiers)
        // continueraient d'afficher l'ancienne valeur.
        const collectionDetail = COLLECTION_DETAIL[cible.role];
        if (collectionDetail) {
            const detailRef = db.collection(collectionDetail).doc(uid);
            if ((await detailRef.get()).exists) batch.update(detailRef, modifications);
        }
        await batch.commit();

        res.json({ uid, ...cible, ...modifications });
    } catch (error) {
        console.error("Erreur updateUserProfile:", error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
};

// --- LOGOUT ---
exports.logout = async (req, res) => {
    try {
        const uid = req.user.uid;
        await admin.auth().revokeRefreshTokens(uid);
        await db.collection('users').doc(uid).update({
            lastLogout: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ message: "Déconnexion réussie" });
    } catch (error) {
        console.error("Erreur Logout:", error);
        res.status(500).json({ error: "Erreur lors de la déconnexion" });
    }
};

const USERS_PAGE_SIZE = 20;
const USERS_PAGE_SIZE_MAX = 100;

/**
 * Normalise une chaîne pour la recherche : minuscules et sans accents, pour que
 * "Rakoto" trouve "rakoto" et "Réné" trouve "rene".
 */
function normaliser(valeur) {
    return String(valeur ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

/** Entier positif borné, avec repli sur `defaut` si le paramètre est invalide. */
function entierPositif(valeur, defaut, max) {
    const n = parseInt(valeur, 10);
    if (!Number.isFinite(n) || n < 1) return defaut;
    return max ? Math.min(n, max) : n;
}

/**
 * GET /api/auth/users?role=&q=&page=&limit=&all=
 * Liste des utilisateurs, avec recherche libre sur le nom, le prénom, l'email
 * et le téléphone. Admin et superadmin.
 *
 * `role` accepte plusieurs valeurs séparées par des virgules
 * (`role=admin,superadmin`) : l'écran d'administration présente les deux
 * niveaux dans un même onglet. Firestore sait le faire avec `in` sur un champ
 * unique, sans index composite.
 *
 * Paginée par défaut (pour les écrans de liste), mais `all=true` renvoie tout :
 * les sélecteurs (choix d'un médecin traitant, par exemple) ont besoin de la
 * liste complète, et une troncature silencieuse y serait un vrai bug.
 * Ce mode ne coûte rien de plus : la recherche impose déjà de charger tous les
 * documents en mémoire, la pagination ne fait que découper le résultat.
 *
 * Firestore ne sait pas faire de recherche "contient" ni de OR sur plusieurs
 * champs : comme ailleurs dans le projet (searchPatients, checkMissedMedications),
 * on filtre en JS après une seule clause `where`, ce qui évite aussi d'avoir à
 * créer un index composite.
 */
exports.listUsersByRole = async (req, res) => {
    try {
        const { role, q } = req.query;
        const tout = req.query.all === 'true' || req.query.all === '1';
        const page = entierPositif(req.query.page, 1);
        const limit = entierPositif(req.query.limit, USERS_PAGE_SIZE, USERS_PAGE_SIZE_MAX);

        const roles = String(role || '')
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean);

        let query = db.collection('users');
        if (roles.length === 1) query = query.where('role', '==', roles[0]);
        else if (roles.length > 1) query = query.where('role', 'in', roles);

        const snap = await query.get();
        let users = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));

        const recherche = normaliser(q).trim();
        if (recherche) {
            users = users.filter((u) => {
                const champs = normaliser(
                    [u.nom, u.prenom, u.email, u.telephone].filter(Boolean).join(' ')
                );
                return champs.includes(recherche);
            });
        }

        // Tri stable avant découpage : sans ordre déterministe, un même
        // utilisateur pourrait apparaître sur deux pages différentes.
        users.sort((a, b) =>
            normaliser(a.nom || a.prenom || a.email).localeCompare(
                normaliser(b.nom || b.prenom || b.email)
            )
        );

        const total = users.length;
        const debut = (page - 1) * limit;
        const affiches = tout ? users : users.slice(debut, debut + limit);

        // Résolu APRÈS le découpage : seuls les comptes réellement renvoyés
        // coûtent une lecture, et elles tiennent en une requête groupée.
        const createurs = await resoudreCreateurs(affiches);
        const data = affiches.map((u) => ({ ...u, createur: blocCreateur(u, createurs) }));

        // En mode `all`, la réponse reste de la même forme : le client n'a pas
        // à gérer deux structures selon le mode.
        res.json({
            data,
            page: tout ? 1 : page,
            limit: tout ? total : limit,
            total,
            totalPages: tout ? 1 : Math.max(1, Math.ceil(total / limit)),
        });
    } catch (error) {
        console.error("Erreur listUsersByRole:", error.message);
        res.status(500).json({ error: error.message });
    }
};

// --- TOGGLE STATUT (superadmin uniquement) ---
exports.toggleUserStatut = async (req, res) => {
    try {
        const { uid } = req.params;

        // Garde-fou : un superadmin qui se désactive lui-même se retrouverait
        // bloqué au login sans personne pour le réactiver.
        if (req.user?.uid === uid) {
            return res.status(400).json({ error: "Vous ne pouvez pas désactiver votre propre compte." });
        }

        const userRef = db.collection('users').doc(uid);
        const snap = await userRef.get();
        if (!snap.exists) return res.status(404).json({ error: "Utilisateur introuvable" });

        const current = snap.data().statut;
        const nouveau = current === 'actif' ? 'inactif' : 'actif';
        await userRef.update({ statut: nouveau });

        // Si on désactive : révoquer les tokens en cours
        if (nouveau === 'inactif') {
            await admin.auth().revokeRefreshTokens(uid);
        }

        res.json({ uid, statut: nouveau });
    } catch (error) {
        console.error("Erreur toggleUserStatut:", error.message);
        res.status(500).json({ error: error.message });
    }
};

// --- CHANGEMENT DE MOT DE PASSE (par le titulaire lui-même) ---
//
// Réponse « oui » à la proposition faite à la première connexion. Le drapeau
// `proposerChangementMotDePasse` retombe à false, comme pour un refus : dans
// les deux cas la question a été posée et ne doit plus revenir.
//
// L'ancien mot de passe n'est pas redemandé : l'appelant vient de s'en servir
// pour obtenir le token que verifyTokenAndRole valide ici, le redemander ne
// prouverait rien de plus et ajouterait un champ à saisir dans un écran qui
// doit rester le plus court possible.
exports.changerMotDePasse = async (req, res) => {
    try {
        const uid = req.user.uid;
        const nouveau = String(req.body.nouveauMotDePasse ?? '');

        if (!nouveau.trim()) {
            return res.status(400).json({ error: "Le nouveau mot de passe est obligatoire." });
        }
        // 8 et non 6 (le minimum de Firebase) : aligné sur ce qu'exigent les
        // écrans de l'application, pour un message d'erreur cohérent.
        if (nouveau.length < 8) {
            return res.status(400).json({
                error: "Le nouveau mot de passe doit faire au moins 8 caractères.",
            });
        }

        await admin.auth().updateUser(uid, { password: nouveau });

        // Pas de revokeRefreshTokens ici, contrairement au renvoi d'identifiants :
        // c'est le titulaire lui-même qui agit, le déconnecter le renverrait à
        // l'écran de login juste après avoir choisi son mot de passe.
        await db.collection('users').doc(uid).update({ proposerChangementMotDePasse: false });

        res.json({ message: "Mot de passe mis à jour." });
    } catch (error) {
        console.error("Erreur changerMotDePasse:", error.message);
        res.status(500).json({ error: "Le mot de passe n'a pas pu être modifié." });
    }
};

// --- REFUS DU CHANGEMENT DE MOT DE PASSE ---
//
// Réponse « non » à la même proposition : le titulaire garde le mot de passe
// reçu par email, qui est un mot de passe à part entière et non un code
// provisoire. On note seulement que la question a été posée, pour ne pas la
// reposer à chaque ouverture de l'application — ce qui la transformerait en
// nuisance et pousserait à l'ignorer machinalement.
exports.conserverMotDePasse = async (req, res) => {
    try {
        await db.collection('users').doc(req.user.uid)
            .update({ proposerChangementMotDePasse: false });
        res.json({ message: "Mot de passe conservé." });
    } catch (error) {
        console.error("Erreur conserverMotDePasse:", error.message);
        res.status(500).json({ error: "L'enregistrement de votre choix a échoué." });
    }
};

// --- RENVOI DES IDENTIFIANTS (admin ou superadmin) ---
//
// Rattrape les cas où le titulaire n'a jamais pu se connecter : SMTP en panne
// au moment de la création, email tombé en indésirables, adresse corrigée
// depuis. Le mot de passe précédent étant irrécupérable — Firebase ne stocke
// qu'une empreinte, et c'est heureux — la seule issue est d'en générer un
// nouveau, ce qui invalide l'ancien.
exports.renvoyerIdentifiants = async (req, res) => {
    try {
        const { uid } = req.params;

        const snap = await db.collection('users').doc(uid).get();
        if (!snap.exists) return res.status(404).json({ error: "Utilisateur introuvable" });

        const utilisateur = snap.data();

        // Un compte Google n'a pas de mot de passe à renvoyer : son accès passe
        // par Google. Lui en attribuer un ne l'aiderait pas et ajouterait un
        // second moyen d'entrer, sans qu'il l'ait demandé.
        if (utilisateur.authProvider === 'google') {
            return res.status(400).json({
                error: "Ce compte se connecte avec Google : il n'a pas de mot de passe à renvoyer.",
            });
        }

        const motDePasse = genererMotDePasse(utilisateur.role);
        await admin.auth().updateUser(uid, { password: motDePasse });

        // Les sessions ouvertes reposaient sur l'ancien mot de passe : les
        // laisser actives voudrait dire que la personne qui l'avait continue
        // d'accéder au compte après le renouvellement.
        await admin.auth().revokeRefreshTokens(uid);

        // Le titulaire repart d'un mot de passe qu'il n'a pas choisi : la
        // proposition d'en définir un lui sera reposée à sa prochaine connexion,
        // même s'il l'avait déclinée auparavant.
        await db.collection('users').doc(uid).update({ proposerChangementMotDePasse: true });

        const emailEnvoye = await notifierIdentifiants({
            req,
            uid,
            email: utilisateur.email,
            nom: utilisateur.nom,
            prenom: utilisateur.prenom,
            role: utilisateur.role,
            motDePasse,
        });

        if (!emailEnvoye) {
            // Le mot de passe a été remplacé mais personne ne l'a reçu : le
            // compte est momentanément inaccessible. Le dire clairement plutôt
            // que de laisser croire à un succès.
            return res.status(502).json({
                error: "Le mot de passe a été renouvelé, mais l'email n'a pas pu être envoyé. "
                    + "Vérifiez la configuration SMTP puis relancez l'opération.",
                emailEnvoye: false,
            });
        }

        res.json({
            uid,
            email: utilisateur.email,
            emailEnvoye: true,
            message: "Un nouveau mot de passe a été envoyé au titulaire du compte.",
        });
    } catch (error) {
        console.error("Erreur renvoyerIdentifiants:", error.message);
        res.status(500).json({ error: error.message });
    }
};
