const express = require('express');
const router = express.Router();
const statsController = require('../controllers/statsController');
const { verifyTokenAndRole } = require('../middlewares/authMiddleware');

router.get(
    '/prescriptions',
    verifyTokenAndRole(['admin', 'superadmin']),
    statsController.getPrescriptionsParPeriode
);

router.get(
    '/prescriptions-par-medecin',
    verifyTokenAndRole(['admin', 'superadmin']),
    statsController.getPrescriptionsParMedecin
);

router.get(
    '/diagnostics',
    verifyTokenAndRole(['admin', 'superadmin']),
    statsController.getDiagnosticsFrequents
);

module.exports = router;
