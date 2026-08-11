/**
 * mailService.js
 *
 * Envoi des emails transactionnels de Mediora, via un serveur SMTP quelconque
 * (nodemailer). Ce module ne connaît ni les rôles, ni Firestore : il reçoit un
 * destinataire et des variables, il poste un message.
 *
 * Pourquoi nodemailer et pas Firebase Auth : Firebase sait envoyer des emails
 * (vérification d'adresse, réinitialisation), mais son catalogue est fermé —
 * il n'existe aucun message « voici vos identifiants », les gabarits sont
 * quasi non personnalisables, l'expéditeur est imposé et le quota journalier
 * n'est pas paramétrable. L'AUTHENTIFICATION reste entièrement chez Firebase :
 * seul l'acheminement du courrier passe par ici.
 *
 * Le transport est décrit par des variables d'environnement génériques
 * (MAIL_HOST / MAIL_PORT / MAIL_USER / MAIL_PASSWORD) et non par un
 * fournisseur codé en dur : passer de Gmail à Brevo ou à un SMTP d'école ne
 * demande alors que de modifier le .env.
 *
 * Variables d'environnement — voir .env.example :
 *   - MAIL_HOST, MAIL_PORT, MAIL_SECURE
 *   - MAIL_USER, MAIL_PASSWORD  (Gmail : mot de passe d'application, pas celui du compte)
 *   - MAIL_FROM       (optionnel) expéditeur affiché, défaut : MAIL_USER
 *   - MAIL_URL_APP    (optionnel) lien « ouvrir l'application » dans le pied de page
 *   - MAIL_DESACTIVE  (optionnel) 'true' → aucun envoi réel, le message est logué
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const DOSSIER_GABARITS = path.join(__dirname, '..', 'templates', 'mail');

/** Libellés affichés dans les emails, à la place des clés techniques. */
const LIBELLES_ROLE = {
    patient: 'Patient',
    medecin: 'Médecin',
    admin: 'Administrateur',
    superadmin: 'Super administrateur',
};

/**
 * Mode « sans envoi » : le message part dans la console au lieu du SMTP.
 *
 * Indispensable en développement et pendant les démonstrations hors ligne —
 * sans lui, chaque test de création de compte enverrait un vrai email à une
 * vraie adresse, et un poste sans réseau ferait échouer l'envoi.
 */
function estDesactive() {
    return String(process.env.MAIL_DESACTIVE || '').trim().toLowerCase() === 'true';
}

/** Lit la configuration SMTP, en signalant précisément ce qui manque. */
function configuration() {
    const host = (process.env.MAIL_HOST || '').trim();
    const user = (process.env.MAIL_USER || '').trim();
    const password = process.env.MAIL_PASSWORD || '';
    const port = Number(process.env.MAIL_PORT || 587);

    const manquants = [];
    if (!host) manquants.push('MAIL_HOST');
    if (!user) manquants.push('MAIL_USER');
    if (!password) manquants.push('MAIL_PASSWORD');
    if (manquants.length) {
        const err = new Error(
            `Configuration SMTP incomplète (${manquants.join(', ')}) : l'envoi d'email est indisponible.`
        );
        err.status = 503;
        throw err;
    }

    return {
        host,
        port,
        // Le port 465 impose TLS dès la connexion ; 587 démarre en clair puis
        // bascule via STARTTLS. Se tromper de couple donne un timeout muet,
        // d'où la déduction automatique quand MAIL_SECURE n'est pas renseigné.
        secure: process.env.MAIL_SECURE
            ? String(process.env.MAIL_SECURE).trim().toLowerCase() === 'true'
            : port === 465,
        auth: { user, pass: password },
    };
}

/**
 * Transporteur nodemailer, créé une seule fois.
 *
 * Le recréer à chaque envoi rouvrirait une connexion SMTP et une négociation
 * TLS par message ; nodemailer garde ici son pool de connexions.
 */
let transporteurCache = null;
function transporteur() {
    if (!transporteurCache) transporteurCache = nodemailer.createTransport(configuration());
    return transporteurCache;
}

/** Expéditeur affiché. Beaucoup de serveurs refusent un From ≠ compte authentifié. */
function expediteur() {
    return (process.env.MAIL_FROM || '').trim() || `Mediora <${(process.env.MAIL_USER || '').trim()}>`;
}

/**
 * Vérifie la configuration au démarrage du serveur.
 *
 * Sans cet appel, une erreur de mot de passe d'application ne se découvre qu'à
 * la première création de compte — c'est-à-dire devant l'utilisateur.
 * Ne lève jamais : un SMTP en panne ne doit pas empêcher l'API de démarrer.
 */
async function verifierConfigurationMail() {
    if (estDesactive()) {
        console.log('📭 MAIL_DESACTIVE=true : les emails seront affichés en console, pas envoyés.');
        return false;
    }
    try {
        await transporteur().verify();
        console.log(`📧 SMTP prêt (${process.env.MAIL_HOST}) — expéditeur : ${expediteur()}`);
        return true;
    } catch (error) {
        console.error(`⚠️  SMTP indisponible : ${error.message}`);
        console.error('   Les comptes seront créés, mais leurs identifiants ne partiront pas par email.');
        return false;
    }
}

/** Échappe le HTML : nom, prénom et email viennent d'une saisie utilisateur. */
function echapperHtml(valeur) {
    return String(valeur ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Charge un gabarit et remplace les `{{cle}}`.
 *
 * Le fichier est relu à chaque envoi, comme le prompt OCR : retoucher le
 * message ne demande pas de redémarrer le serveur.
 *
 * Les blocs `{{#cle}}…{{/cle}}` sont conservés si la variable est non vide et
 * supprimés sinon — juste ce qu'il faut pour les parties optionnelles (le
 * bouton « ouvrir l'application »), sans embarquer un moteur de gabarits.
 */
function rendreGabarit(nom, variables) {
    const chemin = path.join(DOSSIER_GABARITS, `${nom}.html`);
    let html = fs.readFileSync(chemin, 'utf8');

    for (const [cle, valeur] of Object.entries(variables)) {
        const rempli = valeur !== undefined && valeur !== null && String(valeur) !== '';
        html = html.replace(
            new RegExp(`{{#${cle}}}([\\s\\S]*?){{/${cle}}}`, 'g'),
            rempli ? '$1' : ''
        );
        html = html.replace(new RegExp(`{{${cle}}}`, 'g'), echapperHtml(valeur));
    }

    // Blocs dont la variable n'a pas été fournie du tout.
    return html.replace(/{{#\w+}}[\s\S]*?{{\/\w+}}/g, '').replace(/{{\w+}}/g, '');
}

/** Envoi bas niveau, commun à tous les messages. */
async function envoyer({ destinataire, sujet, html, texte }) {
    if (estDesactive()) {
        console.log('📭 [MAIL_DESACTIVE] Email non envoyé :');
        console.log(`   À      : ${destinataire}`);
        console.log(`   Sujet  : ${sujet}`);
        console.log(`   Corps  :\n${texte}`);
        return { simule: true };
    }

    const info = await transporteur().sendMail({
        from: expediteur(),
        to: destinataire,
        subject: sujet,
        text: texte,
        html,
    });
    return { simule: false, messageId: info.messageId };
}

/**
 * Envoie ses identifiants à un compte qui vient d'être créé.
 *
 * C'est le SEUL endroit où le mot de passe généré circule : il n'est ni
 * journalisé, ni renvoyé dans la réponse HTTP, ni stocké en clair. Le
 * créateur du compte ne le connaît donc pas.
 */
async function envoyerIdentifiants({ email, nom, prenom, role, motDePasse, createur }) {
    const identite = `${prenom || ''} ${nom || ''}`.trim() || email;
    const libelleRole = LIBELLES_ROLE[role] || role;
    const urlApp = (process.env.MAIL_URL_APP || '').trim();

    const texte = [
        `Bonjour ${identite},`,
        '',
        `Un compte ${libelleRole} vient d'être créé pour vous sur Mediora${createur ? ` par ${createur}` : ''}.`,
        '',
        'Vos identifiants de connexion :',
        `  Email        : ${email}`,
        `  Mot de passe : ${motDePasse}`,
        '',
        "Vous pouvez aussi vous connecter avec Google, en utilisant cette même adresse email.",
        '',
        "À votre première connexion, l'application vous proposera de définir votre",
        'propre mot de passe. Vous êtes libre de refuser et de garder celui-ci.',
        urlApp ? `\nOuvrir l'application : ${urlApp}` : '',
        '',
        "— L'équipe Mediora",
    ].join('\n');

    const html = rendreGabarit('identifiants', {
        identite,
        libelleRole,
        email,
        motDePasse,
        createur: createur || '',
        urlApp,
    });

    return envoyer({
        destinataire: email,
        sujet: `Vos identifiants Mediora (${libelleRole})`,
        html,
        texte,
    });
}

/**
 * Envoie un lien de réinitialisation.
 *
 * Le lien est produit par Firebase (`generatePasswordResetLink`) : c'est bien
 * Firebase Auth qui reste maître du mot de passe, nodemailer ne fait que
 * porter le message.
 */
async function envoyerLienReset({ email, lien }) {
    const texte = [
        'Bonjour,',
        '',
        'Une réinitialisation de mot de passe a été demandée pour ce compte Mediora.',
        'Ouvrez le lien ci-dessous pour choisir un nouveau mot de passe :',
        '',
        lien,
        '',
        "Si vous n'êtes pas à l'origine de cette demande, ignorez cet email : votre mot de passe reste inchangé.",
        '',
        "— L'équipe Mediora",
    ].join('\n');

    const html = rendreGabarit('reinitialisation', { lien });

    return envoyer({
        destinataire: email,
        sujet: 'Réinitialisation de votre mot de passe Mediora',
        html,
        texte,
    });
}

module.exports = {
    verifierConfigurationMail,
    envoyerIdentifiants,
    envoyerLienReset,
    estDesactive,
};
