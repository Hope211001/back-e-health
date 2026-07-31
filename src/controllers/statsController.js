const { db, admin } = require('../config/firebase');

const PERIODES_VALIDES = ['semaine', 'mois', 'annee'];

/** Date de début de la fenêtre glissante correspondant à la période demandée. */
function getPeriodeStart(periode, now) {
    if (periode === 'semaine') {
        return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    }
    if (periode === 'mois') {
        return new Date(now.getFullYear(), now.getMonth() - 11, 1);
    }
    // annee
    return new Date(now.getFullYear() - 4, 0, 1);
}

function toDate(value) {
    if (!value) return null;
    const d = value?.toDate ? value.toDate() : new Date(value);
    return isNaN(d.getTime()) ? null : d;
}

/**
 * GET /api/stats/prescriptions?periode=semaine|mois|annee
 * Nombre de prescriptions créées, regroupées par jour (semaine), par mois
 * (mois) ou par année (annee). Admin et superadmin.
 */
exports.getPrescriptionsParPeriode = async (req, res) => {
    try {
        const periode = req.query.periode || 'semaine';
        if (!PERIODES_VALIDES.includes(periode)) {
            return res.status(400).json({ error: "Paramètre 'periode' invalide (semaine, mois, annee)" });
        }

        const now = new Date();
        const buckets = [];

        if (periode === 'semaine') {
            // 7 derniers jours, un bucket par jour
            for (let i = 6; i >= 0; i--) {
                const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
                const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
                buckets.push({ label: start.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit' }), start, end });
            }
        } else if (periode === 'mois') {
            // 12 derniers mois, un bucket par mois
            for (let i = 11; i >= 0; i--) {
                const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
                // Pas d'année dans le libellé : sur une fenêtre glissante de 12 mois,
                // chaque nom de mois n'apparaît qu'une seule fois, donc pas d'ambiguïté.
                buckets.push({ label: start.toLocaleDateString('fr-FR', { month: 'short' }), start, end });
            }
        } else {
            // 5 dernières années, un bucket par an
            for (let i = 4; i >= 0; i--) {
                const year = now.getFullYear() - i;
                buckets.push({ label: String(year), start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) });
            }
        }

        // Une seule lecture globale (pas de where sur une plage de dates, pour
        // éviter un index composite) : filtrage/regroupement en JS, comme pour
        // checkMissedMedications / getAlertesToday.
        const oldestStart = buckets[0].start;
        const snapshot = await db.collection('prescriptions').get();

        const counts = new Array(buckets.length).fill(0);
        snapshot.forEach((doc) => {
            const dateCreation = toDate(doc.data().dateCreation);
            if (!dateCreation || dateCreation < oldestStart) return;
            const idx = buckets.findIndex((b) => dateCreation >= b.start && dateCreation < b.end);
            if (idx !== -1) counts[idx]++;
        });

        res.json({
            periode,
            total: counts.reduce((a, b) => a + b, 0),
            data: buckets.map((b, i) => ({ label: b.label, total: counts[i] })),
        });
    } catch (error) {
        console.error("Erreur getPrescriptionsParPeriode:", error.message);
        res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/stats/prescriptions-par-medecin?periode=semaine|mois|annee
 * Nombre de prescriptions créées par chaque médecin sur la période demandée
 * (même fenêtre que /prescriptions), trié décroissant. Admin et superadmin.
 */
exports.getPrescriptionsParMedecin = async (req, res) => {
    try {
        const periode = req.query.periode || 'semaine';
        if (!PERIODES_VALIDES.includes(periode)) {
            return res.status(400).json({ error: "Paramètre 'periode' invalide (semaine, mois, annee)" });
        }
        const periodeStart = getPeriodeStart(periode, new Date());

        const snapshot = await db.collection('prescriptions').get();

        const countsByMedecin = {};
        snapshot.forEach((doc) => {
            const data = doc.data();
            const dateCreation = toDate(data.dateCreation);
            if (!dateCreation || dateCreation < periodeStart) return;
            const medecinId = data.medecinId;
            if (!medecinId) return;
            countsByMedecin[medecinId] = (countsByMedecin[medecinId] || 0) + 1;
        });

        const medecinIds = Object.keys(countsByMedecin);
        if (medecinIds.length === 0) return res.json({ data: [] });

        // Résolution des noms de médecins par lots de 30 (limite de la clause 'in' Firestore).
        const medecinsInfo = {};
        for (let i = 0; i < medecinIds.length; i += 30) {
            const batchIds = medecinIds.slice(i, i + 30);
            const usersSnap = await db.collection('users')
                .where(admin.firestore.FieldPath.documentId(), 'in', batchIds)
                .get();
            usersSnap.forEach((d) => { medecinsInfo[d.id] = d.data(); });
        }

        const data = medecinIds
            .map((id) => {
                const info = medecinsInfo[id] || {};
                const nom = (info.prenom || info.nom)
                    ? `Dr. ${info.prenom || ''} ${info.nom || ''}`.trim()
                    : (info.email || 'Médecin inconnu');
                return { medecinId: id, nom, total: countsByMedecin[id] };
            })
            .sort((a, b) => b.total - a.total);

        res.json({ data });
    } catch (error) {
        console.error("Erreur getPrescriptionsParMedecin:", error.message);
        res.status(500).json({ error: error.message });
    }
};

const TOP_DIAGNOSTICS_LIMIT = 10;

/**
 * GET /api/stats/diagnostics?periode=semaine|mois|annee
 * Diagnostics les plus fréquents (top 10) sur la période demandée (même
 * fenêtre que /prescriptions), le reste étant cumulé sous "Autres".
 * Admin et superadmin.
 */
exports.getDiagnosticsFrequents = async (req, res) => {
    try {
        const periode = req.query.periode || 'semaine';
        if (!PERIODES_VALIDES.includes(periode)) {
            return res.status(400).json({ error: "Paramètre 'periode' invalide (semaine, mois, annee)" });
        }
        const periodeStart = getPeriodeStart(periode, new Date());

        const snapshot = await db.collection('prescriptions').get();

        const countsByDiagnostic = {};
        snapshot.forEach((doc) => {
            const data = doc.data();
            const dateCreation = toDate(data.dateCreation);
            if (!dateCreation || dateCreation < periodeStart) return;

            const brut = data.diagnostic;
            const diagnostic = typeof brut === 'string' ? brut.trim() : '';
            if (!diagnostic) return;
            // Regroupe insensible à la casse (ex: "Grippe" et "grippe" comptent ensemble),
            // en gardant le premier libellé rencontré pour l'affichage.
            const key = diagnostic.toLowerCase();
            if (!countsByDiagnostic[key]) countsByDiagnostic[key] = { label: diagnostic, total: 0 };
            countsByDiagnostic[key].total++;
        });

        const sorted = Object.values(countsByDiagnostic).sort((a, b) => b.total - a.total);
        const top = sorted.slice(0, TOP_DIAGNOSTICS_LIMIT);
        const autresTotal = sorted.slice(TOP_DIAGNOSTICS_LIMIT).reduce((sum, d) => sum + d.total, 0);

        const data = [...top];
        if (autresTotal > 0) data.push({ label: 'Autres', total: autresTotal });

        res.json({
            total: sorted.reduce((sum, d) => sum + d.total, 0),
            diagnosticsDistincts: sorted.length,
            data,
        });
    } catch (error) {
        console.error("Erreur getDiagnosticsFrequents:", error.message);
        res.status(500).json({ error: error.message });
    }
};
