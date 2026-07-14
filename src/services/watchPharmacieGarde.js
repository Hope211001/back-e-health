/**
 * watchPharmacieGarde.js
 *
 * Écoute en TEMPS RÉEL la collection "pharamacieGarde". Dès qu'un document
 * arrive (import n8n) ou change avec des liens Facebook non traités, on
 * télécharge automatiquement les vraies images vers Firebase Storage et on
 * remplace les liens par les URLs Storage permanentes.
 *
 * => Aucune modification du workflow n8n nécessaire : il continue d'écrire les
 *    liens Facebook, le backend fait la conversion tout seul en arrière-plan.
 */
const { admin, db } = require('../config/firebase');
const { rehostAttachements } = require('./pharmacieGardeMedia');

const COLLECTION = 'pharamacieGarde';

// Évite de traiter deux fois le même document en parallèle.
const enCours = new Set();

/**
 * Un document doit être traité s'il contient encore une URL Facebook :
 * - "facebook.com" : lien de page (ancien format)
 * - "fbcdn.net"    : URL image directe MAIS temporaire (expire) → à copier
 *                    sur Cloudinary pour la rendre permanente.
 * Une fois ré-hébergé (res.cloudinary.com), plus aucune de ces chaînes → stop.
 */
function aBesoinDeTraitement(data) {
    const atts = Array.isArray(data.attachement) ? data.attachement : [];
    return atts.some(
        (u) => typeof u === 'string' && (u.includes('facebook.com') || u.includes('fbcdn.net'))
    );
}

async function traiterDocument(docId, data) {
    if (enCours.has(docId)) return;
    enCours.add(docId);

    try {
        const atts = Array.isArray(data.attachement) ? data.attachement : [];
        console.log(`🖼️  Traitement des images de ${docId} (${atts.length} lien(s))...`);

        const rehosted = await rehostAttachements(data.idpost || docId, atts);

        if (rehosted.length) {
            await db.collection(COLLECTION).doc(docId).update({
                attachement: rehosted,
                imagesTraitees: true,
                dateModification: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log(`✅ ${docId} : ${rehosted.length} image(s) enregistrée(s) sur Storage.`);
        } else {
            console.warn(`⚠️ ${docId} : aucune image enregistrée (voir les erreurs ci-dessus : bucket Storage, page privée...).`);
        }
    } catch (error) {
        console.error(`❌ Traitement images ${docId} :`, error.message);
    } finally {
        enCours.delete(docId);
    }
}

/**
 * Démarre l'écoute temps réel. Le tout premier snapshot renvoie aussi les
 * documents existants (type 'added') → le backlog est rattrapé automatiquement.
 */
function watchPharmacieGarde() {
    console.log('👀 Écoute temps réel de la collection "pharamacieGarde" démarrée.');

    return db.collection(COLLECTION).onSnapshot(
        (snapshot) => {
            snapshot.docChanges().forEach((change) => {
                if (change.type === 'added' || change.type === 'modified') {
                    const data = change.doc.data();
                    // Après notre propre update (URLs Storage), il n'y a plus de
                    // lien facebook.com → la condition est fausse → pas de boucle.
                    if (aBesoinDeTraitement(data)) {
                        traiterDocument(change.doc.id, data);
                    }
                }
            });
        },
        (error) => {
            console.error('❌ Erreur listener pharamacieGarde :', error.message);
        }
    );
}

module.exports = { watchPharmacieGarde };
