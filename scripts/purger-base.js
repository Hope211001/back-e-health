/**
 * purger-base.js — remise à zéro des données de test.
 *
 * Efface tout le contenu de la base SAUF :
 *   - les comptes `users` de rôle `superadmin`, et leurs comptes Firebase Auth ;
 *   - la collection `pharamacieGarde` en entier ;
 *   - les documents `ocr` rattachés à une pharmacie de garde conservée ;
 *   - la collection `etablissements`, sauf avec --etablissements (voir plus bas).
 *
 * Usage :
 *   node scripts/purger-base.js                     → SIMULATION, n'efface rien
 *   node scripts/purger-base.js --apply             → efface réellement
 *   node scripts/purger-base.js --apply --etablissements → efface aussi les établissements
 *
 * POURQUOI LES ÉTABLISSEMENTS SONT CONSERVÉS PAR DÉFAUT : ce sont des données
 * de référence, pas des données de test — au même titre que les pharmacies de
 * garde. Une purge sert à repartir d'une base d'utilisateurs vierge, pas à
 * redéclarer la carte sanitaire du pays à chaque fois. Les effacer laisserait
 * en plus le superadmin sans aucun établissement où créer son premier admin.
 *
 * La simulation est le comportement par défaut, comme pour migrer-creePar :
 * une suppression Firestore est définitive, il n'y a pas de corbeille ni
 * d'annulation.
 *
 * ATTENTION : après exécution, le superadmin conservé est le SEUL compte
 * capable de se connecter. Vérifiez que vous en avez le mot de passe avant de
 * lancer avec --apply. En cas de perte : npm run create-superadmin.
 */
require('dotenv').config();
const { db, admin } = require('../src/config/firebase');

const APPLIQUER = process.argv.includes('--apply');
const PURGER_ETABLISSEMENTS = process.argv.includes('--etablissements');

/** Collections vidées intégralement. */
const COLLECTIONS_A_VIDER = [
    'patients',
    'medecins',
    'prescriptions',
    'alertes',
    'notifications',
];

/** Limite d'un batch d'écriture Firestore. */
const TAILLE_BATCH = 500;

/**
 * Supprime une liste de références par lots de 500.
 *
 * Un batch Firestore est plafonné à 500 opérations : avec 719 alertes, un seul
 * batch échouerait en bloc. Le découpage n'est donc pas une optimisation mais
 * une contrainte de l'API.
 */
async function supprimerReferences(refs) {
    if (!APPLIQUER || refs.length === 0) return refs.length;

    for (let i = 0; i < refs.length; i += TAILLE_BATCH) {
        const batch = db.batch();
        refs.slice(i, i + TAILLE_BATCH).forEach((ref) => batch.delete(ref));
        await batch.commit();
    }
    return refs.length;
}

/** Toutes les références d'une collection. */
async function referencesDe(nom) {
    const snap = await db.collection(nom).get();
    return snap.docs.map((d) => d.ref);
}

(async () => {
    console.log(APPLIQUER
        ? '⚠️  MODE RÉEL — les suppressions sont définitives.\n'
        : '🔍 SIMULATION — rien ne sera supprimé. Relancer avec --apply pour exécuter.\n');

    // --- 1. Comptes à conserver -------------------------------------------
    const usersSnap = await db.collection('users').get();
    const superadmins = usersSnap.docs.filter((d) => d.data().role === 'superadmin');
    const uidsConserves = new Set(superadmins.map((d) => d.id));

    if (uidsConserves.size === 0) {
        // Sans ce garde-fou, la purge viderait `users` en entier et rendrait
        // l'application inaccessible : plus aucun compte pour créer les autres.
        console.error('❌ Aucun superadmin trouvé. Purge annulée : personne ne pourrait plus se connecter.');
        process.exit(1);
    }

    console.log('Conservés :');
    superadmins.forEach((d) => console.log(`  superadmin  ${d.id}  ${d.data().email}`));

    // --- 2. Pharmacies de garde et leurs OCR ------------------------------
    const pharmaciesSnap = await db.collection('pharamacieGarde').get();
    const idsPharmacies = new Set(pharmaciesSnap.docs.map((d) => d.id));
    console.log(`  pharamacieGarde  ${idsPharmacies.size} document(s) — collection intacte`);

    // L'ID du document ocr EST le pharmacieGardeId (voir ocrController), mais on
    // lit aussi le champ : un document créé autrement resterait cohérent.
    const ocrSnap = await db.collection('ocr').get();
    const ocrOrphelins = ocrSnap.docs.filter((d) => {
        const lien = d.data().pharmacieGardeId || d.id;
        return !idsPharmacies.has(lien);
    });
    console.log(`  ocr              ${ocrSnap.size - ocrOrphelins.length} rattaché(s) à une pharmacie conservée`);
    if (ocrOrphelins.length) {
        console.log(`                   ${ocrOrphelins.length} orphelin(s) → supprimé(s)`);
    }

    console.log('\nSuppressions :');

    // --- 3. Collections vidées --------------------------------------------
    for (const nom of COLLECTIONS_A_VIDER) {
        const refs = await referencesDe(nom);
        await supprimerReferences(refs);
        console.log(`  ${nom.padEnd(16)} ${String(refs.length).padStart(5)} document(s)`);
    }

    // --- 4. Conversations et leurs messages --------------------------------
    // Les sous-collections ne sont pas supprimées avec leur document parent :
    // effacer une conversation laisserait ses messages orphelins et facturés.
    const conversationsSnap = await db.collection('conversations').get();
    let nbMessages = 0;
    for (const conv of conversationsSnap.docs) {
        const messages = await conv.ref.collection('messages').get();
        nbMessages += messages.size;
        await supprimerReferences(messages.docs.map((m) => m.ref));
    }
    await supprimerReferences(conversationsSnap.docs.map((c) => c.ref));
    console.log(`  ${'conversations'.padEnd(16)} ${String(conversationsSnap.size).padStart(5)} document(s)`);
    console.log(`  ${'  └ messages'.padEnd(16)} ${String(nbMessages).padStart(5)} document(s)`);

    // --- 4 bis. Établissements (sur demande explicite) ----------------------
    // Après cette suppression, le superadmin conservé n'a plus aucun
    // établissement où créer un admin : il devra en enrôler un avant toute
    // autre opération. D'où le drapeau dédié plutôt qu'une purge d'office.
    const etablissementsSnap = await db.collection('etablissements').get();
    if (PURGER_ETABLISSEMENTS) {
        await supprimerReferences(etablissementsSnap.docs.map((d) => d.ref));
        console.log(`  ${'etablissements'.padEnd(16)} ${String(etablissementsSnap.size).padStart(5)} document(s)`);
    } else {
        console.log(
            `  ${'etablissements'.padEnd(16)} ${String(etablissementsSnap.size).padStart(5)} document(s) — CONSERVÉS `
            + `(--etablissements pour les effacer aussi)`
        );
    }

    // --- 5. OCR orphelins --------------------------------------------------
    await supprimerReferences(ocrOrphelins.map((d) => d.ref));
    console.log(`  ${'ocr (orphelins)'.padEnd(16)} ${String(ocrOrphelins.length).padStart(5)} document(s)`);

    // --- 6. Documents users, sauf les superadmins --------------------------
    const usersASupprimer = usersSnap.docs.filter((d) => !uidsConserves.has(d.id));
    await supprimerReferences(usersASupprimer.map((d) => d.ref));
    console.log(`  ${'users'.padEnd(16)} ${String(usersASupprimer.length).padStart(5)} document(s)`);

    // --- 7. Comptes Firebase Auth ------------------------------------------
    // Étape indispensable : Firestore et Firebase Auth sont deux stockages
    // distincts. Ne supprimer que les documents laisserait des comptes dont les
    // adresses email resteraient prises, empêchant de recréer les mêmes
    // utilisateurs ensuite.
    let comptesAuth = [];
    let pageToken;
    do {
        const page = await admin.auth().listUsers(1000, pageToken);
        comptesAuth.push(...page.users);
        pageToken = page.pageToken;
    } while (pageToken);

    const uidsAuthASupprimer = comptesAuth
        .map((u) => u.uid)
        .filter((uid) => !uidsConserves.has(uid));

    if (APPLIQUER && uidsAuthASupprimer.length) {
        // deleteUsers est plafonné à 1000 uid par appel.
        for (let i = 0; i < uidsAuthASupprimer.length; i += 1000) {
            const res = await admin.auth().deleteUsers(uidsAuthASupprimer.slice(i, i + 1000));
            if (res.failureCount) {
                console.error(`  ⚠️  ${res.failureCount} compte(s) Auth non supprimé(s)`);
                res.errors.forEach((e) => console.error(`     ${e.reason}`));
            }
        }
    }
    console.log(`  ${'comptes Auth'.padEnd(16)} ${String(uidsAuthASupprimer.length).padStart(5)} compte(s)`);

    console.log(APPLIQUER
        ? '\n✅ Purge terminée.'
        : '\n🔍 Simulation terminée — aucune donnée touchée.');
    process.exit(0);
})().catch((e) => {
    console.error('Erreur purge :', e.message);
    process.exit(1);
});