/**
 * Script de bootstrap : crée le premier superadmin.
 *
 * Usage :
 *   node scripts/create-superadmin.js <email> <password> [nom] [prenom]
 *
 * Exemple :
 *   node scripts/create-superadmin.js root@patientmed.mg MotDePasse123! Dumoulin Martin
 *
 * À exécuter UNE SEULE FOIS. Le script refuse de créer un 2e superadmin
 * (sécurité : si vous voulez en créer d'autres, passez par un superadmin existant via l'API).
 */

const { db, auth, admin } = require('../src/config/firebase');

async function main() {
    const [, , email, password, nom = '', prenom = ''] = process.argv;

    if (!email || !password) {
        console.error("❌ Usage : node scripts/create-superadmin.js <email> <password> [nom] [prenom]");
        process.exit(1);
    }
    if (password.length < 8) {
        console.error("❌ Le mot de passe doit faire au moins 8 caractères.");
        process.exit(1);
    }

    // Vérifie qu'il n'existe pas déjà un superadmin
    const existing = await db.collection('users').where('role', '==', 'superadmin').limit(1).get();
    if (!existing.empty) {
        const existingUid = existing.docs[0].id;
        console.error(`❌ Un superadmin existe déjà (uid: ${existingUid}).`);
        console.error("   Pour en créer un autre, utilisez l'API /api/auth/register-admin via un superadmin connecté,");
        console.error("   ou supprimez d'abord le superadmin existant.");
        process.exit(1);
    }

    let uid;
    try {
        // Crée ou récupère l'utilisateur Firebase Auth
        try {
            const existingUser = await auth.getUserByEmail(email);
            uid = existingUser.uid;
            console.log(`ℹ️  Utilisateur Firebase Auth existant trouvé (uid: ${uid}). Mise à jour du mot de passe...`);
            await auth.updateUser(uid, { password });
        } catch {
            const userRecord = await auth.createUser({ email, password });
            uid = userRecord.uid;
            console.log(`✅ Utilisateur Firebase Auth créé (uid: ${uid}).`);
        }

        await db.collection('users').doc(uid).set({
            uid,
            email,
            role: 'superadmin',
            nom,
            prenom,
            telephone: '',
            statut: 'actif',
            authProvider: 'password',
            dateCreation: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`\n🎉 Superadmin créé avec succès !`);
        console.log(`   Email    : ${email}`);
        console.log(`   UID      : ${uid}`);
        console.log(`   Connecte-toi via l'app avec ces identifiants.\n`);
        process.exit(0);
    } catch (error) {
        console.error("❌ Erreur :", error.message);
        process.exit(1);
    }
}

main();
