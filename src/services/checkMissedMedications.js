/**
 * checkMissedMedications.js
 *
 * Vérifie les alertes en retard (heure prévue + TOLERANCE dépassée)
 * et les marque comme "manque", puis crée une notification pour le médecin.
 */
const { admin, db } = require('../config/firebase');
const { createNotification } = require('./notificationService');

// Tolérance en minutes avant de considérer un médicament comme manqué (1 heure)
const TOLERANCE_MINUTES = 60;

/**
 * Vérifie toutes les alertes du jour qui sont en retard
 * et crée des notifications pour les médecins concernés.
 */
async function checkMissedMedications() {
    try {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

        // Récupérer les alertes en_attente (un seul where pour éviter l'index composite)
        const snapshot = await db.collection('alertes')
            .where('statut', '==', 'en_attente')
            .get();

        if (snapshot.empty) return;

        // Filtrer en JS pour garder uniquement les alertes du jour
        const todayDocs = snapshot.docs.filter(doc => {
            const data = doc.data();
            if (!data.datePrise) return false;
            const datePrise = data.datePrise.toDate();
            return datePrise >= startOfDay && datePrise < endOfDay;
        });

        if (todayDocs.length === 0) return;

        const batch = db.batch();
        const notificationsToCreate = [];

        for (const doc of todayDocs) {
            const alerte = doc.data();
            const [heures, minutes] = (alerte.heurePrevu || '08:00').split(':').map(Number);

            // Calculer l'heure limite (heure prévue + tolérance)
            const heureLimite = new Date(now);
            heureLimite.setHours(heures, minutes + TOLERANCE_MINUTES, 0, 0);

            // Si on a dépassé la limite → manqué
            if (now > heureLimite) {
                // Marquer l'alerte comme manquée
                batch.update(doc.ref, { statut: 'manque' });

                notificationsToCreate.push({
                    alerteId: doc.id,
                    patientId: alerte.patientId,
                    prescriptionId: alerte.prescriptionId,
                    nomMedicament: alerte.nomMedicament,
                    dosage: alerte.dosage,
                    heurePrevu: alerte.heurePrevu,
                    moment: alerte.moment || '',
                });
            }
        }

        if (notificationsToCreate.length === 0) return;

        await batch.commit();

        // Créer les notifications pour chaque médecin concerné
        for (const data of notificationsToCreate) {
            await createNotificationForMedecin(data);
        }

        console.log(`✅ ${notificationsToCreate.length} alerte(s) manquée(s) détectée(s) et notifiée(s)`);
    } catch (error) {
        console.error('❌ Erreur checkMissedMedications:', error.message);
    }
}

/**
 * Retrouve le médecin traitant du patient et crée une notification.
 */
async function createNotificationForMedecin(data) {
    try {
        // Récupérer le médecin traitant via la prescription
        const prescDoc = await db.collection('prescriptions').doc(data.prescriptionId).get();
        if (!prescDoc.exists) return;

        const medecinId = prescDoc.data().medecinId;

        // Récupérer les infos du patient pour le message
        const patientDoc = await db.collection('patients').doc(data.patientId).get();
        const userDoc = await db.collection('users').doc(data.patientId).get();
        const patientNom = userDoc.exists
            ? `${userDoc.data().prenom || ''} ${userDoc.data().nom || ''}`.trim()
            : (patientDoc.exists ? patientDoc.data().numeroPatient : 'Patient inconnu');

        await createNotification({
            medecinId,
            patientId: data.patientId,
            prescriptionId: data.prescriptionId,
            alerteId: data.alerteId,
            type: 'medication_manquee',
            titre: 'Médicament non pris',
            message: `${patientNom} n'a pas pris "${data.nomMedicament}" (${data.dosage}) prévu à ${data.heurePrevu}.`,
            nomMedicament: data.nomMedicament,
            heurePrevu: data.heurePrevu,
        });
    } catch (error) {
        console.error('❌ Erreur createNotificationForMedecin:', error.message);
    }
}

module.exports = { checkMissedMedications, TOLERANCE_MINUTES };
