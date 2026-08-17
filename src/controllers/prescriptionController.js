const { admin, db } = require('../config/firebase');
const { TOLERANCE_MINUTES } = require('../services/checkMissedMedications');

exports.createPrescription = async (req, res) => {
    try {
        const { patientId, diagnostic, medicaments, duree } = req.body;

        // Vérification de sécurité
        if (!patientId || !medicaments) {
            return res.status(400).json({ error: "Données manquantes (patientId ou médicaments)" });
        }

        const medecinId = req.user.uid;

        // 1. Calcul des dates correctement
        const dateDebut = new Date();
        const dateFin = new Date(); // <--- CORRECTION : Il faut déclarer la variable !

        const dureeInt = parseInt(duree) || 0;
        dateFin.setDate(dateDebut.getDate() + dureeInt);

        const newPrescription = {
            patientId,
            medecinId,
            // Établissement où l'ordonnance a été émise, copié depuis le médecin
            // qui la signe. Sans ce champ, les statistiques d'un admin
            // devraient d'abord lire tous les médecins de son établissement pour
            // savoir quelles ordonnances lui appartiennent — et resteraient
            // fausses dès qu'un praticien est muté, puisque son passé
            // basculerait avec lui dans sa nouvelle structure.
            etablissementId: String(req.user?.etablissementId ?? '').trim(),
            diagnostic: diagnostic || '',
            medicaments,
            duree: dureeInt,
            dateCreation: admin.firestore.FieldValue.serverTimestamp(),
            dateDebut: admin.firestore.Timestamp.fromDate(dateDebut),
            dateFin: admin.firestore.Timestamp.fromDate(dateFin),
            statut: 'en_attente',
            creePar: medecinId
        };

        // 2. Sauvegarde dans Firestore
        const docRef = await db.collection('prescriptions').add(newPrescription);

        // 3. Réponse au front
        res.status(201).json({
            id: docRef.id,
            ...newPrescription,
            dateCreation: new Date() // Pour éviter l'erreur de sérialisation du FieldValue côté front
        });

    } catch (error) {
        console.error("Erreur createPrescription:", error.message);
        res.status(500).json({ error: error.message });
    }
};

exports.getPrescriptionsByPatient = async (req, res) => {
    try {
        const { patientId } = req.params;
        const snapshot = await db.collection('prescriptions')
            .where('patientId', '==', patientId)
            .orderBy('dateCreation', 'desc')
            .get();

        const data = snapshot.docs.map(doc => {
            const item = doc.data();
            
            return {
                id: doc.id,
                ...item,
                // On transforme les Timestamps Firebase en ISO String
                dateCreation: item.dateCreation?.toDate ? item.dateCreation.toDate().toISOString() : item.dateCreation,
                dateDebut: item.dateDebut?.toDate ? item.dateDebut.toDate().toISOString() : item.dateDebut,
                dateFin: item.dateFin?.toDate ? item.dateFin.toDate().toISOString() : item.dateFin
            };
        });

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.getPrescriptionById = async (req, res) => {
    try {
        const { id } = req.params;
        const doc = await db.collection('prescriptions').doc(id).get();

        if (!doc.exists) {
            return res.status(404).json({ error: "Ordonnance introuvable" });
        }

        const data = doc.data();

        // Sécurité
        if (req.user.uid !== data.medecinId && req.user.uid !== data.patientId && req.user.role !== 'superadmin') {
            return res.status(403).json({ error: "Accès non autorisé" });
        }

        // Conversion des Timestamps Firebase en format ISO String pour le Front
        const formattedData = {
            id: doc.id,
            ...data,
            dateCreation: data.dateCreation?.toDate ? data.dateCreation.toDate().toISOString() : data.dateCreation,
            // Fais de même pour dateDebut et dateFin si ce sont des Timestamps
            dateDebut: data.dateDebut?.toDate ? data.dateDebut.toDate().toISOString() : data.dateDebut,
            dateFin: data.dateFin?.toDate ? data.dateFin.toDate().toISOString() : data.dateFin,
        };

        res.json(formattedData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Parse la fréquence du médecin ("Matin: 1, Midi: 0, Soir: 2")
 * Retourne les moments où la quantité > 0 : ['matin', 'soir']
 */
function parseMomentsPrise(frequence) {
    if (!frequence) return ['matin', 'midi', 'soir'];

    const moments = [];
    const lower = frequence.toLowerCase();

    // Format "Matin: 1, Midi: 0, Soir: 2"
    const matinMatch = lower.match(/matin\s*:\s*(\d+)/);
    const midiMatch = lower.match(/midi\s*:\s*(\d+)/);
    const soirMatch = lower.match(/soir\s*:\s*(\d+)/);

    if (matinMatch || midiMatch || soirMatch) {
        if (matinMatch && parseInt(matinMatch[1]) > 0) moments.push('matin');
        if (midiMatch && parseInt(midiMatch[1]) > 0) moments.push('midi');
        if (soirMatch && parseInt(soirMatch[1]) > 0) moments.push('soir');
        return moments.length > 0 ? moments : ['matin', 'midi', 'soir'];
    }

    // Format texte libre ("3 fois par jour", "matin et soir", etc.)
    if (lower.includes('matin')) moments.push('matin');
    if (lower.includes('midi')) moments.push('midi');
    if (lower.includes('soir')) moments.push('soir');

    return moments.length > 0 ? moments : ['matin', 'midi', 'soir'];
}

/**
 * Vrai si le moment de prise est déjà dépassé au moment du démarrage.
 *
 * Sert à ne PAS créer, le jour du démarrage, les prises dont l'heure est
 * passée : un patient qui confirme son traitement à 20 h voyait apparaître un
 * « matin 08:00 » et un « midi 12:00 » immédiatement en retard, puis signalés
 * comme oubliés à son médecin — alors qu'il venait tout juste de commencer.
 *
 * La même tolérance que le contrôle des oublis est appliquée, et ce n'est pas
 * un détail : la règle devient « on ne crée une prise que si elle ne serait pas
 * déclarée manquée dans la foulée ». À 08 h 20 pour une prise de 08 h, elle
 * reste donc proposée — le patient a encore le temps de la prendre.
 */
function momentDejaPasse(heurePrevu, maintenant) {
    const [h, m] = String(heurePrevu || '').split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return false;

    const limite = new Date(maintenant);
    limite.setHours(h, m + TOLERANCE_MINUTES, 0, 0);
    return maintenant.getTime() > limite.getTime();
}

/**
 * Le patient confirme le début de sa prise de médicament.
 * - Lit les horaires personnalisés du patient (matin/midi/soir)
 * - dateDebut = maintenant, statut = 'en_cours'
 * - Génère les alertes en mappant Matin/Midi/Soir → heures du patient,
 *   EN COMMENÇANT à la première prise encore réalisable (voir momentDejaPasse)
 * - dateFin est déduite de la dernière prise réellement programmée, et non de
 *   dateDebut + duree : le nombre de doses prescrites est conservé, quitte à
 *   déborder d'un jour quand le traitement démarre en cours de journée.
 */
exports.startPrescription = async (req, res) => {
    try {
        const { id } = req.params;
        const patientId = req.user.uid;
        const horairesFromBody = req.body?.horairesRappel || null;

        const docRef = db.collection('prescriptions').doc(id);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ error: "Ordonnance introuvable" });
        }

        const prescription = docSnap.data();

        if (prescription.patientId !== patientId) {
            return res.status(403).json({ error: "Accès non autorisé" });
        }

        if (prescription.statut === 'en_cours') {
            return res.status(400).json({ error: "Cette prescription est déjà en cours" });
        }
        if (prescription.statut === 'terminee') {
            return res.status(400).json({ error: "Cette prescription est déjà terminée" });
        }

        // Priorité : body > prescription.horairesRappel > patient.horairesRappel > défaut
        let horaires = horairesFromBody || prescription.horairesRappel;
        if (!horaires) {
            const patientDoc = await db.collection('patients').doc(patientId).get();
            horaires = patientDoc.exists ? (patientDoc.data().horairesRappel || {}) : {};
        }
        const heuresMap = {
            matin: horaires.matin || '08:00',
            midi:  horaires.midi  || '12:00',
            soir:  horaires.soir  || '20:00',
        };

        // Le traitement commence À L'INSTANT de la confirmation, pas au début
        // de la journée : c'est la première prise encore réalisable qui ouvre
        // le traitement.
        const dateDebut = new Date();
        const duree = parseInt(prescription.duree) || 7;

        // Génération des alertes
        const batch = db.batch();
        const medicaments = prescription.medicaments || [];
        let alerteCount = 0;
        /** Dernière prise programmée, toutes lignes confondues → dateFin. */
        let dernierePrise = null;
        /** Première prise programmée, renvoyée au client pour l'informer. */
        let premierePrise = null;

        for (const med of medicaments) {
            const moments = parseMomentsPrise(med.frequence);
            const medDuree = parseInt(med.duree) || duree;

            // Nombre de doses réellement prescrites. On le conserve : sauter
            // les prises déjà passées sans compenser amputerait la cure de
            // deux doses sur un « 3 fois par jour pendant 7 jours », alors que
            // l'instruction médicale est d'aller au bout du traitement.
            const dosesAttendues = medDuree * moments.length;

            let creees = 0;
            // Un jour de plus que la durée : c'est ce jour supplémentaire qui
            // absorbe les prises sautées le premier jour. La borne sert aussi
            // de garde-fou contre une boucle sans fin.
            for (let jour = 0; jour <= medDuree && creees < dosesAttendues; jour++) {
                for (const moment of moments) {
                    if (creees >= dosesAttendues) break;

                    const datePrise = new Date(dateDebut);
                    datePrise.setDate(datePrise.getDate() + jour);

                    // Seul le jour du démarrage peut porter des heures déjà
                    // écoulées ; les jours suivants sont entiers.
                    if (jour === 0 && momentDejaPasse(heuresMap[moment], dateDebut)) continue;

                    const alerteRef = db.collection('alertes').doc();
                    batch.set(alerteRef, {
                        patientId,
                        prescriptionId: id,
                        medicamentId: med.id || med.nomMedicament,
                        nomMedicament: med.nomMedicament,
                        dosage: med.dosage || '',
                        moment: moment,
                        heurePrevu: heuresMap[moment],
                        datePrise: admin.firestore.Timestamp.fromDate(datePrise),
                        statut: 'en_attente',
                        notificationEnvoyee: false,
                    });
                    alerteCount++;
                    creees++;

                    if (!dernierePrise || datePrise > dernierePrise) dernierePrise = datePrise;
                    if (!premierePrise || datePrise < premierePrise) premierePrise = datePrise;
                }
            }
        }

        // Déduite de la dernière prise, et non de dateDebut + duree : un
        // traitement démarré le soir se termine un jour plus tard, et une
        // dateFin trop courte ferait passer les dernières prises pour des
        // alertes hors traitement.
        const dateFin = dernierePrise ? new Date(dernierePrise) : new Date(dateDebut);
        if (!dernierePrise) dateFin.setDate(dateFin.getDate() + duree);

        // Mise à jour de la prescription (avec horaires figés sur la prescription)
        await docRef.update({
            dateDebut: admin.firestore.Timestamp.fromDate(dateDebut),
            dateFin: admin.firestore.Timestamp.fromDate(dateFin),
            statut: 'en_cours',
            horairesRappel: heuresMap,
        });

        await batch.commit();

        res.json({
            message: "Prescription démarrée avec succès",
            dateDebut: dateDebut.toISOString(),
            dateFin: dateFin.toISOString(),
            statut: 'en_cours',
            alertesCrees: alerteCount,
            // Permet à l'application d'annoncer « première prise ce soir à
            // 20:00 » plutôt que de laisser croire à un démarrage immédiat.
            premierePrise: premierePrise ? premierePrise.toISOString() : null,
        });
    } catch (error) {
        console.error("Erreur startPrescription:", error.message);
        res.status(500).json({ error: error.message });
    }
};

/**
 * Récupère les alertes du jour pour le patient connecté
 */
exports.getAlertesToday = async (req, res) => {
    try {
        const patientId = req.user.uid;

        // Début et fin de la journée
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

        // Un seul where pour éviter l'index composite, filtrage date en JS
        const snapshot = await db.collection('alertes')
            .where('patientId', '==', patientId)
            .get();

        const alertes = snapshot.docs
            .map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    ...data,
                    datePrise: data.datePrise?.toDate ? data.datePrise.toDate().toISOString() : data.datePrise,
                    prisLe: data.prisLe?.toDate ? data.prisLe.toDate().toISOString() : data.prisLe,
                };
            })
            .filter(a => {
                const d = new Date(a.datePrise);
                return d >= startOfDay && d < endOfDay;
            });

        // Trier par heurePrevu
        alertes.sort((a, b) => a.heurePrevu.localeCompare(b.heurePrevu));

        res.json(alertes);
    } catch (error) {
        console.error("Erreur getAlertesToday:", error.message);
        res.status(500).json({ error: error.message });
    }
};

/**
 * Le patient marque une alerte comme "pris"
 */
exports.markAlertePrise = async (req, res) => {
    try {
        const { id } = req.params;
        const patientId = req.user.uid;

        const docRef = db.collection('alertes').doc(id);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ error: "Alerte introuvable" });
        }

        if (docSnap.data().patientId !== patientId) {
            return res.status(403).json({ error: "Accès non autorisé" });
        }

        await docRef.update({
            statut: 'pris',
            prisLe: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.json({ message: "Médicament marqué comme pris" });
    } catch (error) {
        console.error("Erreur markAlertePrise:", error.message);
        res.status(500).json({ error: error.message });
    }
};

/**
 * PUT /api/prescription/alertes/marquer-pris
 * Marque une prise à partir du CONTEXTE de la notification, et non de l'id de
 * l'alerte : { prescriptionId, moment, nomMedicament }.
 *
 * Pourquoi une route de plus alors que `markAlertePrise` existe déjà : la
 * notification locale est programmée sur le téléphone au démarrage du
 * traitement, et elle ne transporte que ce que l'application connaissait à ce
 * moment-là — le médicament, le moment, la prescription. Jamais l'identifiant
 * de l'alerte, qui est créé côté serveur.
 *
 * L'alternative aurait été d'embarquer cet identifiant dans chaque
 * notification, mais elle ne répare rien pour les traitements DÉJÀ en cours :
 * leurs notifications sont programmées, figées dans le système Android, et il
 * faudrait redémarrer chaque ordonnance pour les régénérer.
 *
 * La date n'est pas un paramètre : une prise se déclare pour AUJOURD'HUI. La
 * rendre choisissable par le client permettrait de réécrire l'observance des
 * jours passés depuis le téléphone, ce qui viderait la donnée de son sens.
 */
exports.marquerPrisParContexte = async (req, res) => {
    try {
        const patientId = req.user.uid;
        const { prescriptionId, moment, nomMedicament } = req.body;

        if (!prescriptionId) {
            return res.status(400).json({ error: "prescriptionId est obligatoire." });
        }

        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

        // Une seule clause `where`, filtrage en JS : convention du projet, qui
        // évite un index composite par combinaison de champs interrogée.
        const snapshot = await db.collection('alertes')
            .where('patientId', '==', patientId)
            .get();

        const candidates = snapshot.docs.filter((doc) => {
            const a = doc.data();
            if (a.prescriptionId !== prescriptionId) return false;

            const datePrise = a.datePrise?.toDate ? a.datePrise.toDate() : new Date(a.datePrise);
            if (!(datePrise >= startOfDay && datePrise < endOfDay)) return false;

            // `moment` et `nomMedicament` affinent quand ils sont fournis. Une
            // ordonnance porte souvent plusieurs médicaments au même horaire :
            // sans le nom, un appui sur « J'ai pris » en validerait plusieurs
            // d'un coup, dont un que le patient n'a pas encore avalé.
            if (moment && a.moment !== moment) return false;
            if (nomMedicament && a.nomMedicament !== nomMedicament) return false;

            return true;
        });

        if (candidates.length === 0) {
            return res.status(404).json({ error: "Aucune alerte correspondante aujourd'hui." });
        }

        // Les alertes déjà prises sont ignorées, pas réécrites : `prisLe`
        // enregistre l'heure réelle de la déclaration, et un second appui —
        // fréquent, la notification restant parfois affichée — la décalerait.
        const aMarquer = candidates.filter((doc) => doc.data().statut !== 'pris');

        if (aMarquer.length > 0) {
            const batch = db.batch();
            for (const doc of aMarquer) {
                // Une alerte déjà basculée en `manque` redevient `pris` : c'est
                // le rattrapage normal quand la déclaration arrive après le
                // passage du contrôle horaire.
                batch.update(doc.ref, {
                    statut: 'pris',
                    prisLe: admin.firestore.FieldValue.serverTimestamp(),
                });
            }
            await batch.commit();
        }

        res.json({
            marquees: aMarquer.length,
            dejaPrises: candidates.length - aMarquer.length,
            alerteIds: aMarquer.map((d) => d.id),
        });
    } catch (error) {
        console.error("Erreur marquerPrisParContexte:", error.message);
        res.status(500).json({ error: error.message });
    }
};

/**
 * Sauvegarde les horaires de rappel propres à une prescription (sans la démarrer)
 */
exports.updatePrescriptionHoraires = async (req, res) => {
    try {
        const { id } = req.params;
        const patientId = req.user.uid;
        const { horairesRappel } = req.body;

        if (!horairesRappel || typeof horairesRappel !== 'object') {
            return res.status(400).json({ error: "horairesRappel requis" });
        }

        const docRef = db.collection('prescriptions').doc(id);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ error: "Ordonnance introuvable" });
        }

        const prescription = docSnap.data();
        if (prescription.patientId !== patientId) {
            return res.status(403).json({ error: "Accès non autorisé" });
        }

        const heuresMap = {
            matin: horairesRappel.matin || '08:00',
            midi:  horairesRappel.midi  || '12:00',
            soir:  horairesRappel.soir  || '20:00',
        };

        await docRef.update({ horairesRappel: heuresMap });

        // Traitement déjà démarré : on répercute les nouvelles heures sur les
        // alertes pas encore déclenchées. Celles déjà notifiées/prises/manquées
        // restent inchangées (on ne réécrit pas l'historique).
        let alertesMisesAJour = 0;
        if (prescription.statut === 'en_cours') {
            const alertesSnap = await db.collection('alertes')
                .where('prescriptionId', '==', id)
                .where('statut', '==', 'en_attente')
                .get();

            const batch = db.batch();
            alertesSnap.forEach((alerteDoc) => {
                const nouvelleHeure = heuresMap[alerteDoc.data().moment];
                if (nouvelleHeure) {
                    batch.update(alerteDoc.ref, { heurePrevu: nouvelleHeure });
                    alertesMisesAJour++;
                }
            });
            if (alertesMisesAJour > 0) await batch.commit();
        }

        res.json({ message: "Horaires sauvegardés", horairesRappel: heuresMap, alertesMisesAJour });
    } catch (error) {
        console.error("Erreur updatePrescriptionHoraires:", error.message);
        res.status(500).json({ error: error.message });
    }
};

exports.getPatientById = async (req, res) => {
    try {
        const { id } = req.params;
        const doc = await db.collection('patients').doc(id).get();

        if (!doc.exists) {
            return res.status(404).json({ error: "Patient non trouvé" });
        }

        res.json({ id: doc.id, ...doc.data() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};