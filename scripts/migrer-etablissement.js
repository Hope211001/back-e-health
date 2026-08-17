/**
 * Migration : rattache les comptes existants à un établissement.
 *
 * Avant le passage en multi-établissements, aucun document ne portait
 * `etablissementId`. Sans ce script, tous les comptes antérieurs restent hors
 * périmètre : ils n'apparaissent dans la liste d'aucun admin, et leurs
 * administrateurs ne peuvent plus créer personne.
 *
 * Usage :
 *   node scripts/migrer-etablissement.js                      # simulation
 *   node scripts/migrer-etablissement.js --apply              # applique
 *   node scripts/migrer-etablissement.js --etablissement=<id> # cible explicite
 *
 * Sans `--etablissement`, le script prend le SEUL établissement existant. S'il
 * y en a plusieurs, il s'arrête : deviner lequel reviendrait à répartir des
 * dossiers médicaux entre des hôpitaux au hasard. S'il n'y en a aucun, il en
 * propose la création via `--creer="Nom|type|ville"`.
 *
 * Idempotent : un document qui porte déjà un `etablissementId` non vide n'est
 * jamais retouché, le script peut donc être relancé.
 *
 * CE QUI EST MIGRÉ ET DANS QUEL ORDRE :
 *   1. users (hors superadmin)  — la source de vérité du cloisonnement
 *   2. medecins / patients      — copies de détail lues par les écrans
 *   3. prescriptions            — rattachées à l'établissement de LEUR MÉDECIN,
 *                                 pas à la cible : une ordonnance est un fait
 *                                 daté, elle appartient à la structure qui l'a
 *                                 émise. En pratique les deux coïncident après
 *                                 cette migration, mais la règle reste juste si
 *                                 le script est relancé plus tard.
 *
 * LES SUPERADMINS SONT VOLONTAIREMENT IGNORÉS : leur portée est nationale, un
 * `etablissementId` les cantonnerait à un hôpital tout en leur laissant les
 * pouvoirs de l'échelon au-dessus.
 */

const { db, admin } = require('../src/config/firebase');
const { TYPES_ETABLISSEMENT } = require('../src/services/etablissementService');

/** Firestore refuse les lots de plus de 500 écritures. */
const TAILLE_LOT = 400;

/** Valeur d'un argument `--cle=valeur`, ou null. */
function argument(cle) {
    const trouve = process.argv.find((a) => a.startsWith(`--${cle}=`));
    return trouve ? trouve.slice(cle.length + 3) : null;
}

/** Vrai si le document n'a pas encore de rattachement exploitable. */
function aRattacher(data) {
    return !String(data?.etablissementId ?? '').trim();
}

/**
 * Établissement cible : celui passé en argument, le seul existant, ou celui que
 * `--creer` demande de créer.
 */
async function resoudreCible(appliquer) {
    const demande = argument('etablissement');
    if (demande) {
        const snap = await db.collection('etablissements').doc(demande).get();
        if (!snap.exists) throw new Error(`Établissement ${demande} introuvable.`);
        return { id: snap.id, ...snap.data() };
    }

    const snap = await db.collection('etablissements').get();

    if (snap.size === 1) {
        const doc = snap.docs[0];
        return { id: doc.id, ...doc.data() };
    }

    if (snap.size > 1) {
        console.log('\nÉtablissements existants :');
        snap.docs.forEach((d) => console.log(`  ${d.id}  ${d.data().nom} (${d.data().ville})`));
        throw new Error(
            'Plusieurs établissements existent : précisez la cible avec '
            + '--etablissement=<id>. Répartir des comptes au hasard entre des '
            + 'structures ferait basculer des dossiers médicaux dans le mauvais périmètre.'
        );
    }

    // Aucun établissement : le script peut en créer un, mais uniquement sur
    // demande explicite — en fabriquer un silencieusement donnerait un nom
    // inventé à la structure qui héberge toutes les données existantes.
    const creer = argument('creer');
    if (!creer) {
        throw new Error(
            'Aucun établissement en base. Créez-en un depuis l\'application '
            + '(superadmin → Établissements), ou relancez avec '
            + '--creer="Nom de l\'hôpital|CHU|Antananarivo".'
        );
    }

    const [nom, type, ville] = creer.split('|').map((s) => (s || '').trim());
    if (!nom || !type || !ville) {
        throw new Error('--creer attend le format "Nom|type|ville".');
    }
    if (!TYPES_ETABLISSEMENT.includes(type)) {
        throw new Error(`Type invalide : attendu ${TYPES_ETABLISSEMENT.join(', ')}.`);
    }

    const etablissement = {
        nom, type, ville,
        region: '', adresse: '', telephone: '', email: '',
        statut: 'actif',
        creePar: 'migration',
        dateCreation: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!appliquer) {
        console.log(`\n🔍 L'établissement « ${nom} » (${type}, ${ville}) serait créé.`);
        return { id: '(à créer)', ...etablissement };
    }

    const ref = await db.collection('etablissements').add(etablissement);
    console.log(`\n✅ Établissement « ${nom} » créé (${ref.id}).`);
    return { id: ref.id, ...etablissement };
}

/** Rattache une collection entière, en lots. Renvoie le nombre de documents visés. */
async function migrerCollection(nomCollection, etablissementId, appliquer, filtre = () => true) {
    const snap = await db.collection(nomCollection).get();
    const candidats = snap.docs.filter((d) => aRattacher(d.data()) && filtre(d.data()));

    console.log(
        `  ${nomCollection.padEnd(14)} ${String(candidats.length).padStart(4)} à rattacher `
        + `(${snap.size} document(s) au total)`
    );
    if (candidats.length === 0 || !appliquer) return candidats.length;

    for (let i = 0; i < candidats.length; i += TAILLE_LOT) {
        const batch = db.batch();
        for (const doc of candidats.slice(i, i + TAILLE_LOT)) {
            batch.update(doc.ref, { etablissementId });
        }
        await batch.commit();
    }
    return candidats.length;
}

/**
 * Prescriptions : rattachées à l'établissement de leur médecin émetteur.
 *
 * Une ordonnance appartient à la structure où elle a été signée, pas à celle où
 * le patient est suivi aujourd'hui. C'est ce qui garde les statistiques justes
 * après un transfert de patient ou une mutation de praticien.
 */
async function migrerPrescriptions(defaut, appliquer) {
    const [prescriptionsSnap, usersSnap] = await Promise.all([
        db.collection('prescriptions').get(),
        db.collection('users').get(),
    ]);

    const etablissementParMedecin = new Map();
    usersSnap.forEach((d) => {
        const data = d.data();
        if (data.role === 'medecin') {
            etablissementParMedecin.set(d.id, String(data.etablissementId ?? '').trim());
        }
    });

    const candidats = prescriptionsSnap.docs.filter((d) => aRattacher(d.data()));
    let sansMedecin = 0;

    console.log(
        `  prescriptions  ${String(candidats.length).padStart(4)} à rattacher `
        + `(${prescriptionsSnap.size} document(s) au total)`
    );
    if (candidats.length === 0) return 0;

    for (let i = 0; i < candidats.length; i += TAILLE_LOT) {
        const batch = db.batch();
        for (const doc of candidats.slice(i, i + TAILLE_LOT)) {
            const medecinId = doc.data().medecinId;
            // Repli sur la cible quand le médecin a été supprimé : mieux vaut
            // une ordonnance visible dans l'établissement principal qu'une
            // ordonnance qui n'apparaît nulle part.
            const resolu = etablissementParMedecin.get(medecinId);
            if (!resolu) sansMedecin++;
            if (appliquer) batch.update(doc.ref, { etablissementId: resolu || defaut });
        }
        if (appliquer) await batch.commit();
    }

    if (sansMedecin) {
        console.log(`    ↳ ${sansMedecin} sans médecin résolu, rattachée(s) à l'établissement cible.`);
    }
    return candidats.length;
}

async function main() {
    const appliquer = process.argv.includes('--apply');

    console.log(appliquer
        ? '⚙️  Mode APPLICATION — les documents vont être modifiés.'
        : '🔍 Mode SIMULATION — aucune écriture. Ajoutez --apply pour appliquer.');

    const cible = await resoudreCible(appliquer);
    console.log(`\nÉtablissement cible : ${cible.nom} (${cible.ville}) — ${cible.id}\n`);

    let total = 0;
    // Le superadmin est exclu : sa portée est nationale.
    total += await migrerCollection('users', cible.id, appliquer, (d) => d.role !== 'superadmin');
    total += await migrerCollection('medecins', cible.id, appliquer);
    total += await migrerCollection('patients', cible.id, appliquer);
    total += await migrerPrescriptions(cible.id, appliquer);

    console.log(appliquer
        ? `\n✅ ${total} document(s) rattaché(s).`
        : `\n🔍 ${total} document(s) seraient rattachés. Relancez avec --apply pour écrire.`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ Erreur :', error.message);
        process.exit(1);
    });
