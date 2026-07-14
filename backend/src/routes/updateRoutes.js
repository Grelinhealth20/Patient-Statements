import { Router } from 'express';
import { getLatestManifest, getUpdateArtifact } from '../controllers/updateController.js';

/**
 * Public desktop auto-update feed. No authentication — the electron-updater client
 * sends no token. `latest.yml` is matched first, then any allowed artifact file.
 */
const router = Router();

router.get('/latest.yml', getLatestManifest);
router.get('/:file', getUpdateArtifact);

export default router;
