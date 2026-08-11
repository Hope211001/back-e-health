/**
 * Migration : remonte la trace « créé par » des médecins vers `users`.
 *
 * Avant l'ajout de la traçabilité, seul `medecins/{uid}.creePar` était écrit —
 * `users/{uid}` n'en portait rien. Ce script recopie cette information là où
 * les écrans la lisent désormais, et déduit `creeParRole` du rôle ACTUEL du
 * créateur.
 *
 * Usage :
 *   node scripts/migrer-creePar.js            # simulation, n'écrit rien
 *   node scripts/migrer-creePar.js --apply    # applique les modifications
 *
 * Idempotent : un compte qui porte déjà `creePar` n'est jamais retouché, le
 * script peut donc être relancé sans risque.
 *
 * PORTÉE VOLONTAIREMENT LIMITÉE AUX MÉDECINS. Les patients ne sont pas migrés :
 * leur `medecinTraitantId` désigne le médecin traitant, pas forcément le
 * créateur du compte (l'administration peut créer un patient en rattachant
 * n'importe quel médecin). Les recopier reviendrait à inventer une traçabilité
 * fausse dans une partie des cas — mieux vaut « Origine non enregistrée », qui
 * est exact.
 */

const { db } = require('../src/config/firebase');

/** Firestore refuse les lots de plus de 500 écritures. */
const TAILLE_LOT = 400;

/** Rôle actuel des créateurs référencés, en une requête groupée. */
async function lireRolesCreateurs(uids) {
    if (uids.length === 0) return new Map();

    const roles = new Map();
    // `getAll` accepte un nombre raisonnable de références : on découpe par
    // sécurité si la base contient beaucoup de créateurs distincts.
    for (let i = 0; i < uids.length; i += TAILLE_LOT) {
        const tranche = uids.slice(i, i + TAILLE_LOT);
        const snaps = await db.getAll(...tranche.map((uid) => db.collection('users').doc(uid)));
        for (const snap of snaps) {
            if (snap.exists) roles.set(snap.id, snap.data().role || null);
        }
    }
    return roles;
}

async function main() {
    const appliquer = process.argv.includes('--apply');

    console.log(appliquer
        ? '⚙️  Mode APPLICATION — les documents vont être modifiés.\n'
        : '🔍 Mode SIMULATION — aucune écriture. Ajoutez --apply pour appliquer.\n');

    const medecinsSnap = await db.collection('medecins').get();
    console.log(`${medecinsSnap.size} document(s) dans « medecins ».`);

    // Candidats : un médecin dont le document de détail porte `creePar`.
    const candidats = [];
    for (const doc of medecinsSnap.docs) {
        const creePar = doc.data().creePar;
        if (creePar) candidats.push({ uid: doc.id, creePar });
    }
    console.log(`${candidats.length} portent un « creePar » exploitable.`);

    if (candidats.length === 0) {
        console.log('\nRien à migrer.');
        return;
    }

    // État côté `users` : on ne touche que ceux à qui l'information manque.
    const usersSnaps = await db.getAll(
        ...candidats.map((c) => db.collection('users').doc(c.uid))
    );

    const aMigrer = [];
    let deja = 0;
    let absents = 0;

    usersSnaps.forEach((snap, i) => {
        if (!snap.exists) { absents++; return; }
        if (snap.data().creePar) { deja++; return; }
        aMigrer.push(candidats[i]);
    });

    console.log(`  — ${deja} déjà migré(s), ignoré(s)`);
    console.log(`  — ${absents} sans document « users » correspondant, ignoré(s)`);
    console.log(`  — ${aMigrer.length} à migrer\n`);

    if (aMigrer.length === 0) return;

    const roles = await lireRolesCreateurs([...new Set(aMigrer.map((c) => c.creePar))]);

    let ecrits = 0;
    for (let i = 0; i < aMigrer.length; i += TAILLE_LOT) {
        const tranche = aMigrer.slice(i, i + TAILLE_LOT);
        const batch = db.batch();

        for (const { uid, creePar } of tranche) {
            // Rôle ACTUEL du créateur, faute de mieux : le rôle d'origine n'a
            // jamais été enregistré. L'écart n'existe que si le créateur a
            // changé de rôle depuis, ce qui reste marginal.
            const role = roles.get(creePar) || null;
            console.log(`  ${uid} ← créé par ${creePar}${role ? ` (${role})` : ' (compte introuvable)'}`);

            if (appliquer) {
                batch.update(db.collection('users').doc(uid), {
                    creePar,
                    creeParRole: role,
                });
            }
            ecrits++;
        }

        if (appliquer) await batch.commit();
    }

    console.log(appliquer
        ? `\n✅ ${ecrits} compte(s) migré(s).`
        : `\n🔍 ${ecrits} compte(s) seraient migrés. Relancez avec --apply pour écrire.`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Erreur :', error.message);
        process.exit(1);
    });