import { Router, raw } from 'express';
import { requireAuth, requireStatementAccess, blockIfPasswordChangeRequired } from '../middleware/auth.js';
import { env } from '../config/env.js';
import {
  importRows,
  listPatients,
  financialSummary,
  addressQueue,
  listPendingPatients,
  listPatientDos,
  validatePatientAddress,
  updatePatientAddress,
  addressValidationStatus,
  generateStatement,
  storeStatementPdf,
  downloadStatement,
} from '../controllers/statementController.js';

const router = Router();

// Everything here requires an authenticated user with Statement Generator access whose
// password is already set (a temp-password account must reset it first).
router.use(requireAuth, blockIfPasswordChangeRequired, requireStatementAccess);

router.get('/ping', (req, res) => {
  res.json({ ok: true, message: 'Statement Generator access confirmed.' });
});

router.post('/import', importRows);
router.get('/patients', listPatients);
router.get('/summary', financialSummary);
router.get('/patients/address-queue', addressQueue);
router.get('/patients/pending', listPendingPatients);
router.get('/patients/:key/dos', listPatientDos);
router.post('/patients/:key/validate-address', validatePatientAddress);
router.put('/patients/:key/address', updatePatientAddress);
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
