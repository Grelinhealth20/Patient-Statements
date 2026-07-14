import {
  isS3Configured,
  getObjectText,
  getPresignedObjectUrl,
  objectExists,
  S3StorageError,
} from '../utils/s3.js';

/**
 * Desktop auto-update feed (electron-updater, "generic" provider).
 *
 * The release artifacts live in the SAME private S3 bucket as the statement PDFs,
 * under the `desktop-updates/` prefix — nothing is ever made public. This API
 * serves them safely:
 *   - latest.yml  → streamed as text straight from S3 (tiny)
 *   - the .exe / .blockmap → a 302 redirect to a short-lived presigned S3 URL, so
 *     the large binary is downloaded directly from S3 and never passes through the
 *     serverless function (which has a small response-size limit).
 *
 * These routes are intentionally unauthenticated (the updater sends no token) and
 * are mounted before the DB gate so update checks work even if the DB is briefly
 * unavailable.
 */

const UPDATE_PREFIX = 'desktop-updates';
// Only these exact artifacts may be fetched — never allow arbitrary bucket keys.
const ALLOWED_ARTIFACTS = new Set([
  'statementgenerator.exe',
  'statementgenerator.exe.blockmap',
]);

/** GET /api/updates/latest.yml — the version manifest electron-updater polls. */
export async function getLatestManifest(req, res, next) {
  try {
    if (!isS3Configured()) {
      return res.status(503).type('text/plain').send('Update feed is not configured.');
    }
    const body = await getObjectText(`${UPDATE_PREFIX}/latest.yml`);
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('text/yaml').send(body);
  } catch (err) {
    if (err instanceof S3StorageError && err.status === 404) {
      return res.status(404).type('text/plain').send('No release has been published yet.');
    }
    next(err);
  }
}

/** GET /api/updates/:file — redirect the installer/blockmap to a presigned S3 URL. */
export async function getUpdateArtifact(req, res, next) {
  try {
    const file = String(req.params.file || '');
    if (!ALLOWED_ARTIFACTS.has(file)) {
      return res.status(404).type('text/plain').send('Not found.');
    }
    if (!isS3Configured()) {
      return res.status(503).type('text/plain').send('Update feed is not configured.');
    }
    const key = `${UPDATE_PREFIX}/${file}`;
    if (!(await objectExists(key))) {
      return res.status(404).type('text/plain').send('Not found.');
    }
    const url = await getPresignedObjectUrl({ key, expiresIn: 600 });
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.redirect(302, url);
  } catch (err) {
    next(err);
  }
}
