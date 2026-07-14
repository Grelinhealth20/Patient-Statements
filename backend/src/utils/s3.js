import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

/**
 * Enterprise-grade Amazon S3 client for durable storage of generated statement
 * PDFs.
 *
 * The bucket, region and credentials live only on the server (env.s3) and are
 * never exposed to the browser. Statements are uploaded once at generation time
 * and served back to the client through short-lived presigned GET URLs, so the
 * PDF bytes never pass through (or are cached by) the API server on download.
 *
 * When AWS credentials are omitted from the environment the AWS default
 * credential provider chain is used (IAM instance role, shared config, etc.) —
 * the recommended approach for production deployments.
 */

const s = (v) => (v == null ? '' : String(v)).trim();

/** A structured error carrying an HTTP status so controllers can map it cleanly. */
export class S3StorageError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'S3StorageError';
    this.status = status;
  }
}

/** True when a bucket is configured, i.e. statement archival is enabled. */
export function isS3Configured() {
  return !!s(env.s3.bucket);
}

let client = null;

/** Lazily construct (and cache) a single S3 client for the process. */
function getClient() {
  if (!isS3Configured()) {
    throw new S3StorageError('Statement storage is not configured on the server.', 503);
  }
  if (client) return client;

  const config = { region: env.s3.region };
  // Only pass explicit static credentials when both are present; otherwise defer
  // to the AWS default provider chain.
  if (env.s3.accessKeyId && env.s3.secretAccessKey) {
    config.credentials = {
      accessKeyId: env.s3.accessKeyId,
      secretAccessKey: env.s3.secretAccessKey,
    };
  }
  client = new S3Client(config);
  return client;
}

/** Strip anything unsafe from a single S3 key segment (never allow traversal). */
function safeSegment(str) {
  return s(str).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
}

/**
 * Deterministic, collision-free object key for one statement PDF:
 *   <prefix>/user-<userId>/statement-<statementId>/<fileName>
 * The statement id guarantees uniqueness; the file name stays human-readable.
 */
export function buildStatementKey({ userId, statementId, fileName }) {
  const prefix = safeSegment(env.s3.keyPrefix || 'statements');
  const name = safeSegment(fileName || `statement-${statementId}.pdf`);
  const finalName = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
  return `${prefix}/user-${safeSegment(String(userId))}/statement-${safeSegment(String(statementId))}/${finalName}`;
}

/**
 * Upload a statement PDF to S3.
 * @param {object} p
 * @param {string} p.key           Object key (see buildStatementKey).
 * @param {Buffer} p.body          PDF bytes.
 * @param {string} [p.contentType] MIME type (default application/pdf).
 * @param {object} [p.metadata]    Optional user metadata (string→string).
 * @returns {Promise<{ bucket: string, key: string }>}
 */
export async function putStatementPdf({ key, body, contentType = 'application/pdf', metadata = {} }) {
  const s3 = getClient();
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: env.s3.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Sensible enterprise defaults: encryption at rest + no public access.
        ServerSideEncryption: 'AES256',
        Metadata: Object.fromEntries(
          Object.entries(metadata || {}).map(([k, v]) => [k, s(v)])
        ),
      })
    );
    return { bucket: env.s3.bucket, key };
  } catch (err) {
    throw new S3StorageError(`Failed to store the statement PDF: ${err.message}`, 502);
  }
}

/**
 * Create a short-lived presigned GET URL that downloads the object as an
 * attachment with a friendly file name (Content-Disposition).
 * @returns {Promise<string>}
 */
export async function getPresignedDownloadUrl({ key, fileName, expiresIn }) {
  const s3 = getClient();
  const disposition = fileName
    ? `attachment; filename="${s(fileName).replace(/"/g, '')}"`
    : 'attachment';
  try {
    return await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: env.s3.bucket,
        Key: key,
        ResponseContentDisposition: disposition,
        ResponseContentType: 'application/pdf',
      }),
      { expiresIn: expiresIn || env.s3.presignExpirySeconds || 300 }
    );
  } catch (err) {
    throw new S3StorageError(`Could not create a download link: ${err.message}`, 502);
  }
}

/**
 * Read a (small) text object from S3 as a UTF-8 string. Used by the desktop
 * auto-update feed to serve latest.yml straight from the private bucket without
 * ever making the object public.
 */
export async function getObjectText(key) {
  const s3 = getClient();
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }));
    return await out.Body.transformToString('utf-8');
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') {
      throw new S3StorageError(`Object not found: ${key}`, 404);
    }
    throw new S3StorageError(`Could not read ${key}: ${err.message}`, 502);
  }
}

/**
 * Short-lived presigned GET URL for an arbitrary object. The desktop updater is
 * redirected here to download the (large) installer directly from S3, so the bytes
 * never flow through the API and the bucket stays fully private.
 */
export async function getPresignedObjectUrl({ key, expiresIn = 600 }) {
  const s3 = getClient();
  try {
    return await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }), { expiresIn });
  } catch (err) {
    throw new S3StorageError(`Could not create a link for ${key}: ${err.message}`, 502);
  }
}

/**
 * Permanently delete EVERY stored statement object under the app's key prefix.
 * Scoped to `<keyPrefix>/` so it can never touch unrelated objects in a shared
 * bucket. Lists and deletes in pages of up to 1000 (the S3 batch limit) until the
 * prefix is empty. Used only by the super-admin "Delete All" purge.
 *
 * @returns {Promise<{ deleted: number, configured: boolean }>}
 */
export async function deleteAllStatementObjects() {
  if (!isS3Configured()) return { deleted: 0, configured: false };
  const s3 = getClient();
  const prefix = `${safeSegment(env.s3.keyPrefix || 'statements')}/`;
  let deleted = 0;
  let token;
  try {
    do {
      const list = await s3.send(
        new ListObjectsV2Command({ Bucket: env.s3.bucket, Prefix: prefix, ContinuationToken: token })
      );
      const objects = (list.Contents || []).map((o) => ({ Key: o.Key }));
      if (objects.length) {
        await s3.send(
          new DeleteObjectsCommand({ Bucket: env.s3.bucket, Delete: { Objects: objects, Quiet: true } })
        );
        deleted += objects.length;
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    return { deleted, configured: true };
  } catch (err) {
    throw new S3StorageError(`Failed to wipe stored PDFs from S3: ${err.message}`, 502);
  }
}

/** Confirm an object exists (used to guard downloads against a missing key). */
export async function objectExists(key) {
  const s3 = getClient();
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.s3.bucket, Key: key }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false;
    throw new S3StorageError(`Could not verify the stored statement: ${err.message}`, 502);
  }
}
