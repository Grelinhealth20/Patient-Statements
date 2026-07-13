import { Router, raw } from 'express';
import { requireAuth, requireStatementAccess } from '../middleware/auth.js';
import { env } from '../config/env.js';
import {
  importRows,
  listPatients,
  listPendingPatients,
  listPatientDos,
  validatePatientAddress,
  addressValidationStatus,
  generateStatement,
  storeStatementPdf,
  downloadStatement,
} from '../controllers/statementController.js';

const router = Router();

// Everything here requires an authenticated user with Statement Generator access.
router.use(requireAuth, requireStatementAccess);

router.get('/ping', (req, res) => {
  res.json({ ok: true, message: 'Statement Generator access confirmed.' });
});

router.post('/import', importRows);
router.get('/patients', listPatients);
router.get('/patients/pending', listPendingPatients);
router.get('/patients/:key/dos', listPatientDos);
router.post('/patients/:key/validate-address', validatePatientAddress);
router.get('/address-validation/status', addressValidationStatus);
router.post('/generate', generateStatement);

// Archive a generated PDF to S3. The body is the raw PDF (not JSON), so a
// dedicated raw parser handles it — bounded to the configured max PDF size.
router.post(
  '/:id/pdf',
  raw({ type: ['application/pdf', 'application/octet-stream'], limit: env.s3.maxPdfBytes }),
  storeStatementPdf
);
// Hand back a short-lived presigned download URL for a stored statement PDF.
router.get('/:id/download', downloadStatement);

export default router;
