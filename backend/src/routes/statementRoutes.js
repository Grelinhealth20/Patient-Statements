import { Router } from 'express';
import { requireAuth, requireStatementAccess } from '../middleware/auth.js';
import {
  importRows,
  listPatients,
  listPatientDos,
  generateStatement,
} from '../controllers/statementController.js';

const router = Router();

// Everything here requires an authenticated user with Statement Generator access.
router.use(requireAuth, requireStatementAccess);

router.get('/ping', (req, res) => {
  res.json({ ok: true, message: 'Statement Generator access confirmed.' });
});

router.post('/import', importRows);
router.get('/patients', listPatients);
router.get('/patients/:key/dos', listPatientDos);
router.post('/generate', generateStatement);

export default router;
