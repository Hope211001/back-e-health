/**
 * seed-geo.js — amorce le référentiel des villes et migre les données existantes.
 *
 * Deux étapes :
 *   1. crée une ville par valeur `etablissements.ville` distincte ;
 *   2. pose `etablissements.villeId` et retire l'ancien champ texte.
 *
 * Usage :
 *   node scripts/seed-geo.js            → SIMULATION, n'écrit rien
 *   node scripts/seed-geo.js --apply    → applique
 *
 * Idempotent : une ville déjà présente n'est jamais recréée, un établissement
 * déjà porteur de `villeId` n'est pas retouché. Le script peut donc être
 * relancé sans risque.
 *
 * POURQUOI L'ANCIEN CHAMP EST RETIRÉ. Laisser `ville` en texte à côté de
 * `villeId` créerait deux sources de vérité pour la même information : au
 * premier renommage de commune, les documents afficheraient l'ancienne valeur
 * ou la nouvelle selon l'écran qui les lit. C'est exactement l'anomalie de mise
 * à jour que la normalisation supprime — la garder à moitié serait pire que ne
 * pas normaliser du tout.
 *
 * Le champ `region`, également en texte libre, est supprimé sans être repris :
 * il n'existe plus dans le modèle.
 */
require('dotenv').config();
const { db, admin } = require('../src/config/firebase');
const { COLLECTION_VILLES, cleLibelle } = require('../src/services/geoService');

const APPLIQUER = process.argv.includes('--apply');

/** Firestore refuse les lots de plus de 500 écritures. */
const TAILLE_LOT = 400;

async function commitParLots(operations) {
    if (!APPLIQUER || operations.length === 0) return;
    for (let i = 0; i < operations.length; i += TAILLE_LOT) {
        const batch = db.batch();
        operations.slice(i, i + TAILLE_LOT).forEach((op) => op(batch));
        await batch.commit();
    }
}

(async () => {
    console.log(APPLIQUER
        ? '⚙️  Mode APPLICATION — les documents vont être écrits.\n'
        : '🔍 Mode SIMULATION — aucune écriture. Ajoutez --apply pour appliquer.\n');

    // --- 1. Villes déduites des établissements -----------------------------
    console.log('=== Villes ===');
    const etabSnap = await db.collection('etablissements').get();

    const villesSnap = await db.collection(COLLECTION_VILLES).get();
    /** clé normalisée du nom → id de ville, pour ne pas créer de doublon. */
    const villesParCle = new Map();
    villesSnap.forEach((d) => villesParCle.set(cleLibelle(d.data().nom), d.id));

    const opsVilles = [];
    /** id d'établissement → id de ville à poser à l'étape 2. */
    const villeParEtablissement = new Map();
    let villesCreees = 0;

    for (const doc of etabSnap.docs) {
        const e = doc.data();

        if (String(e.villeId || '').trim()) {
            console.log(`  ${e.nom} → déjà rattaché (villeId présent), ignoré.`);
            continue;
        }

        const nomVille = String(e.ville || '').trim();
        if (!nomVille) {
            console.log(`  ⚠️  ${e.nom} → aucune ville renseignée, ignoré.`);
            continue;
        }

        const cle = cleLibelle(nomVille);
        let villeId = villesParCle.get(cle);

        if (!villeId) {
            const ref = db.collection(COLLECTION_VILLES).doc();
            villeId = ref.id;
            opsVilles.push((batch) => batch.set(ref, {
                nom: nomVille,
                statut: 'actif',
                creePar: null, // amorçage par script, pas par un compte
                dateCreation: admin.firestore.FieldValue.serverTimestamp(),
            }));
            villesParCle.set(cle, villeId);
            villesCreees++;
            console.log(`  + ${nomVille}`);
        } else {
            // Deux orthographes de la même ville convergent ici vers le même
            // document : c'est le moment où les doublons existants sont
            // fusionnés.
            console.log(`  = ${nomVille} → ville déjà existante, réutilisée`);
        }

        villeParEtablissement.set(doc.id, villeId);
    }
    await commitParLots(opsVilles);
    console.log(`  ${villesSnap.size} déjà présente(s), ${villesCreees} à créer.\n`);

    // --- 2. Rattachement des établissements --------------------------------
    console.log('=== Établissements ===');
    const opsEtab = [];
    for (const [etabId, villeId] of villeParEtablissement) {
        const e = etabSnap.docs.find((d) => d.id === etabId).data();
        console.log(`  ${e.nom} → villeId=${villeId} (champs « ville » et « region » retirés)`);
        opsEtab.push((batch) => batch.update(db.collection('etablissements').doc(etabId), {
            villeId,
            ville: admin.firestore.FieldValue.delete(),
            region: admin.firestore.FieldValue.delete(),
        }));
    }
    await commitParLots(opsEtab);
    console.log(`  ${villeParEtablissement.size} établissement(s) à rattacher.\n`);

    console.log(APPLIQUER
        ? '✅ Amorçage terminé.'
        : '🔍 Simulation terminée — relancez avec --apply pour écrire.');
    process.exit(0);
})().catch((e) => {
    console.error('❌ Erreur seed-geo :', e.message);
    process.exit(1);
});
