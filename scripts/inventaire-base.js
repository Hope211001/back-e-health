/**
 * inventaire-base.js — LECTURE SEULE, n'écrit et ne supprime rien.
 *
 * Dresse l'état de la base avant une purge : combien de documents par
 * collection, et lesquels seraient conservés.
 *
 *   node scripts/inventaire-base.js
 */
require('dotenv').config();
const { db, admin } = require('../src/config/firebase');

const COLLECTIONS = [
    'users',
    'patients',
    'medecins',
    'prescriptions',
    'alertes',
    'notifications',
    'conversations',
    'pharamacieGarde',
    'ocr',
];

(async () => {
    console.log('=== Documents par collection ===\n');

    let totalMessages = 0;
    for (const nom of COLLECTIONS) {
        const snap = await db.collection(nom).get();
        console.log(`${nom.padEnd(16)} ${String(snap.size).padStart(5)}`);

        // Les messages vivent en sous-collection des conversations : ils ne
        // disparaissent pas avec le document parent et doivent être comptés
        // (et supprimés) explicitement.
        if (nom === 'conversations') {
            for (const doc of snap.docs) {
                const msgs = await doc.ref.collection('messages').get();
                totalMessages += msgs.size;
            }
            console.log(`${'  └ messages'.padEnd(16)} ${String(totalMessages).padStart(5)}`);
        }
    }

    console.log('\n=== Comptes users par rôle ===\n');
    const users = await db.collection('users').get();
    const parRole = {};
    users.forEach((d) => {
        const r = d.data().role || '(sans rôle)';
        parRole[r] = (parRole[r] || 0) + 1;
    });
    for (const [role, n] of Object.entries(parRole)) {
        console.log(`${role.padEnd(16)} ${String(n).padStart(5)}`);
    }

    console.log('\n=== Superadmins (CONSERVÉS) ===\n');
    users.docs
        .filter((d) => d.data().role === 'superadmin')
        .forEach((d) => {
            const u = d.data();
            console.log(`  ${d.id}  ${u.email}  ${(u.prenom || '')} ${(u.nom || '')}`.trimEnd());
        });

    console.log('\n=== Comptes Firebase Auth ===\n');
    // Les documents Firestore et les comptes Auth sont deux stockages distincts :
    // supprimer l'un laisse l'autre, et un email resterait pris sans profil.
    const listeAuth = await admin.auth().listUsers(1000);
    console.log(`  ${listeAuth.users.length} compte(s) dans Firebase Auth`);
    const uidsSuperadmin = new Set(
        users.docs.filter((d) => d.data().role === 'superadmin').map((d) => d.id)
    );
    console.log(`  dont ${uidsSuperadmin.size} superadmin(s) à conserver`);
    console.log(`  → ${listeAuth.users.length - uidsSuperadmin.size} compte(s) Auth seraient supprimés`);

    process.exit(0);
})().catch((e) => {
    console.error('Erreur inventaire :', e.message);
    process.exit(1);
});