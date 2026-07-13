import { getPool } from '../config/db.js';
import { env } from '../config/env.js';
import { writeAudit } from '../config/initDb.js';
import { validateAddress, extractValidatedAddress, buildApiStatus } from '../utils/addressValidation.js';
import { getAddressValidationUsage } from '../utils/billingUsage.js';
import { recordApiCall, getMonthlyCallCount } from '../utils/apiUsage.js';
import {
  isS3Configured,
  buildStatementKey,
  putStatementPdf,
  getPresignedDownloadUrl,
  S3StorageError,
} from '../utils/s3.js';

/* ------------------------------------------------------------------ helpers */

const s = (v) => (v == null ? '' : String(v)).trim();
const norm = (v) => s(v).toLowerCase().replace(/\s+/g, ' ');

// Guardrails for a single import request (keeps memory + payload bounded).
const MAX_IMPORT_ROWS = 25000;
const INSERT_CHUNK = 1000;

/** Grouping key for a patient: account number when present, else patient name. */
function patientKeyOf(row) {
  const acct = norm(row.accountNumber);
  const name = norm(row.patientName);
  return acct || name;
}

/** Stable short hash for rows that carry no Date-Of-Service (so they don't collapse). */
function hash(str) {
  let h = 5381;
  const t = String(str);
  for (let i = 0; i < t.length; i += 1) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** DOS identity key: normalised Date Of Service, or a data hash when absent. */
function dosKeyOf(row) {
  const d = norm(row.dateOfService || row.statementDate);
  return d || `h:${hash(JSON.stringify(row))}`;
}

function safeName(str) {
  return s(str).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'statement';
}

/** Keep a human-readable name for a file: strip only filesystem-illegal chars, keep spaces. */
function fsafe(str) {
  return s(str).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Parse a date-ish value (ISO, M/D/YYYY, or Date-parseable) to a Date, or null. */
function parseDate(v) {
  const str = s(v);
  if (!str) return null;
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);       // ISO: YYYY-MM-DD[...]
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);         // M/D/YYYY
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

/** mm-dd-yyyy (filename-safe date). */
function dosStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()}`;
}

/** Join address parts, dropping blanks. */
function joinParts(parts, sep = ', ') {
  return parts.map((p) => s(p)).filter(Boolean).join(sep);
}

/**
 * Two-line office address from a DOS data object:
 *   line1: "Office Name, Address"
 *   line2: "City, State ZipCode"
 */
function officeAddressOf(data) {
  if (!data) return { line1: '', line2: '' };
  const stateZip = joinParts([data.state, data.zipCode], ' ');
  return {
    line1: joinParts([data.officeName, data.address]),
    line2: joinParts([data.city, stateZip]),
  };
}

/**
 * Two-line patient address from a DOS data object:
 *   line1: "Patient Address 1"
 *   line2: "Patient Address 2"
 */
function patientAddressOf(data) {
  if (!data) return { line1: '', line2: '' };
  return { line1: s(data.patientAddress1), line2: s(data.patientAddress2) };
}

/* ------------------------------------------------------------- POST /import */

/**
 * Persist parsed statement rows. New (patient, DOS) pairs are inserted as
 * pending; duplicates (same patient + Date Of Service) are skipped so
 * already-generated DOS are never disturbed. Append-only, keeps history.
 */
export async function importRows(req, res, next) {
  try {
    const userId = req.user.id;
    const fileName = s(req.body?.fileName);
    if (!Array.isArray(req.body?.rows)) {
      return res.status(400).json({ message: 'Request body must include a rows array.' });
    }
    const rows = req.body.rows;
    if (!rows.length) {
      return res.status(400).json({ message: 'No statement rows to import.' });
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      return res.status(413).json({ message: `Too many rows in one import (max ${MAX_IMPORT_ROWS}). Please split the file.` });
    }

    const pool = getPool();
    // Build a de-duplicated set for this batch (first occurrence of each identity wins).
    const seen = new Set();
    const values = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue; // ignore malformed entries
      const pKey = patientKeyOf(row);
      if (!pKey) continue; // skip rows with no patient identity
      const dKey = dosKeyOf(row);
      const uniq = `${pKey}|${dKey}`;
      if (seen.has(uniq)) continue;
      seen.add(uniq);
      values.push([
        userId,
        s(row.accountNumber).slice(0, 64),
        s(row.patientName).slice(0, 191),
        pKey.slice(0, 160),
        s(row.dateOfService || row.statementDate).slice(0, 80),
        dKey.slice(0, 80),
        JSON.stringify(row),
        fileName.slice(0, 255),
      ]);
    }

    if (!values.length) {
      return res.status(400).json({ message: 'No valid patient rows found in the upload.' });
    }

    // INSERT IGNORE relies on the unique (user_id, patient_key, dos_key) key to
    // skip DOS that already exist for this user — that is the append/dedupe rule.
    // Chunked so a very large upload never exceeds max_allowed_packet.
    let inserted = 0;
    for (let i = 0; i < values.length; i += INSERT_CHUNK) {
      const chunk = values.slice(i, i + INSERT_CHUNK);
      const [result] = await pool.query(
        `INSERT IGNORE INTO statement_dos
           (user_id, account_number, patient_name, patient_key, dos_date, dos_key, data, source_file)
         VALUES ?`,
        [chunk]
      );
      inserted += result.affectedRows || 0;
    }

    const skipped = values.length - inserted;
    await writeAudit({
      actorId: userId,
      action: 'statements.import',
      detail: `file=${fileName} rows=${rows.length} inserted=${inserted} skipped=${skipped}`,
    });

    return res.json({ imported: inserted, skipped, received: rows.length });
  } catch (err) {
    next(err);
  }
}

/* --------------------------------------------------------- GET /patients */

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

/** Clamp a query param to a positive integer within [min, max], or a fallback. */
function intParam(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Grouped, paginated patient list for the dashboard table. Status is 'pending'
 * when the patient has any ungenerated DOS, otherwise 'generated'. The latest
 * statement supplies the shown Generated Date + File Name.
 *
 * Query params: page (1-based, default 1), pageSize (default 10, max 100).
 * Response: { patients, pagination: { page, pageSize, total, totalPages },
 *             totals: { patients, dos, pending, generated } }.
 * The per-page joins (latest statement + sample DOS) are scoped to the page's
 * patient keys, so cost stays bounded regardless of how many patients exist.
 */
export async function listPatients(req, res, next) {
  try {
    const userId = req.user.id;
    const pool = getPool();

    const pageSize = intParam(req.query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);

    // Aggregate totals across ALL of this user's patients (for the KPI row and
    // pagination), independent of the current page.
    const [[agg]] = await pool.query(
      `SELECT
         COUNT(*)                     AS totalPatients,
         COALESCE(SUM(g.dosCount), 0) AS totalDos,
         COALESCE(SUM(g.pendingCount > 0), 0) AS pendingPatients
       FROM (
         SELECT d.patient_key,
                COUNT(*) AS dosCount,
                SUM(d.status = 'pending') AS pendingCount
         FROM statement_dos d
         WHERE d.user_id = :userId
         GROUP BY d.patient_key
       ) g`,
      { userId }
    );
    const total = Number(agg.totalPatients || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(intParam(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER), totalPages);
    const offset = (page - 1) * pageSize;

    const pagination = { page, pageSize, total, totalPages };
    const totals = {
      patients: total,
      dos: Number(agg.totalDos || 0),
      pending: Number(agg.pendingPatients || 0),
      generated: total - Number(agg.pendingPatients || 0),
    };

    // The page of grouped patients (ordered by name). LIMIT/OFFSET are validated
    // integers, so inlining them is safe.
    const [rows] = await pool.query(
      `SELECT
         d.patient_key                                   AS patientKey,
         MAX(d.patient_name)                             AS patientName,
         MAX(d.account_number)                           AS accountNumber,
         COUNT(*)                                        AS dosCount,
         SUM(d.status = 'pending')                       AS pendingCount,
         SUM(d.status = 'generated')                     AS generatedCount
       FROM statement_dos d
       WHERE d.user_id = :userId
       GROUP BY d.patient_key
       ORDER BY MAX(d.patient_name)
       LIMIT ${pageSize} OFFSET ${offset}`,
      { userId }
    );

    if (!rows.length) {
      return res.json({ patients: [], pagination, totals });
    }

    // Named-placeholder IN clause scoped to just this page's patient keys.
    const keys = rows.map((r) => r.patientKey);
    const keyParams = {};
    keys.forEach((k, i) => { keyParams[`k${i}`] = k; });
    const inList = keys.map((_, i) => `:k${i}`).join(', ');

    // Latest statement per patient_key on this page (generated date + file name).
    const [stmts] = await pool.query(
      `SELECT s1.id AS statementId, s1.patient_key AS patientKey, s1.file_name AS fileName,
              s1.generated_at AS generatedAt, s1.dos_count AS dosCount, s1.s3_key AS s3Key
       FROM statements s1
       JOIN (
         SELECT patient_key, MAX(id) AS maxId
         FROM statements WHERE user_id = :userId AND patient_key IN (${inList}) GROUP BY patient_key
       ) last ON last.maxId = s1.id
       WHERE s1.user_id = :userId`,
      { userId, ...keyParams }
    );
    const latest = new Map(stmts.map((r) => [r.patientKey, r]));

    // One representative DOS row per patient on this page — supplies the office +
    // patient address shown at the patient level.
    const [sampleRows] = await pool.query(
      `SELECT d.patient_key AS patientKey, d.data AS data
       FROM statement_dos d
       JOIN (
         SELECT patient_key, MIN(id) AS minId
         FROM statement_dos WHERE user_id = :userId AND patient_key IN (${inList}) GROUP BY patient_key
       ) f ON f.minId = d.id
       WHERE d.user_id = :userId`,
      { userId, ...keyParams }
    );
    const sample = new Map(
      sampleRows.map((r) => [r.patientKey, typeof r.data === 'string' ? JSON.parse(r.data) : r.data])
    );

    const patients = rows.map((r) => {
      const pending = Number(r.pendingCount || 0);
      const last = latest.get(r.patientKey) || null;
      const data = sample.get(r.patientKey) || null;
      return {
        key: r.patientKey,
        patientName: r.patientName || '',
        accountNumber: r.accountNumber || '',
        officeAddress: officeAddressOf(data),
        patientAddress: patientAddressOf(data),
        addressValidated: !!(data && data.addressValidated),
        dosCount: Number(r.dosCount || 0),
        pendingCount: pending,
        generatedCount: Number(r.generatedCount || 0),
        status: pending > 0 ? 'pending' : 'generated',
        lastFileName: last ? last.fileName : '',
        lastGeneratedAt: last ? last.generatedAt : null,
        lastStatementId: last ? Number(last.statementId) : null,
        lastStored: !!(last && last.s3Key), // PDF archived to S3 and downloadable
      };
    });

    return res.json({ patients, pagination, totals });
  } catch (err) {
    next(err);
  }
}

/* -------------------------------------------------- GET /patients/pending */

/**
 * Lightweight list of every patient with at least one pending (ungenerated) DOS,
 * for the "Send to Engine" selector. Unpaginated by design — the selector must
 * offer every generatable patient regardless of the table's current page. No
 * address/statement joins, so it stays cheap even with many patients.
 */
export async function listPendingPatients(req, res, next) {
  try {
    const userId = req.user.id;
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT d.patient_key                 AS \`key\`,
              MAX(d.patient_name)            AS patientName,
              MAX(d.account_number)          AS accountNumber,
              COUNT(*)                       AS dosCount,
              SUM(d.status = 'pending')      AS pendingCount,
              SUM(d.status = 'generated')    AS generatedCount
       FROM statement_dos d
       WHERE d.user_id = :userId
       GROUP BY d.patient_key
       HAVING pendingCount > 0
       ORDER BY MAX(d.patient_name)`,
      { userId }
    );
    const patients = rows.map((r) => ({
      key: r.key,
      patientName: r.patientName || '',
      accountNumber: r.accountNumber || '',
      dosCount: Number(r.dosCount || 0),
      pendingCount: Number(r.pendingCount || 0),
      generatedCount: Number(r.generatedCount || 0),
    }));
    return res.json({ patients });
  } catch (err) {
    next(err);
  }
}

/* ----------------------------------------------- GET /patients/:key/dos */

/** Every DOS line for one patient (for the expandable table detail). */
export async function listPatientDos(req, res, next) {
  try {
    const userId = req.user.id;
    const key = norm(req.params.key);
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, dos_date AS dosDate, status, statement_id AS statementId,
              data, source_file AS sourceFile, created_at AS createdAt
       FROM statement_dos
       WHERE user_id = :userId AND patient_key = :key
       ORDER BY dos_date, id`,
      { userId, key }
    );
    const dos = rows.map((r) => ({
      id: r.id,
      dosDate: r.dosDate,
      status: r.status,
      statementId: r.statementId,
      sourceFile: r.sourceFile || '',
      createdAt: r.createdAt,
      data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data,
    }));
    return res.json({ dos });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------- POST /patients/:key/validate-address */

/**
 * Validate one patient's mailing address with the Google Address Validation API
 * and, on success, persist the standardized address across ALL of that patient's
 * DOS rows so every future statement uses the corrected address.
 *
 * The existing patient address (patientAddress1 + patientAddress2) is the input.
 * The Google API key stays server-side; the browser only sees the result.
 */
export async function validatePatientAddress(req, res, next) {
  try {
    const userId = req.user.id;
    const key = norm(req.params.key);
    if (!key) return res.status(400).json({ message: 'A patient must be specified.' });

    const pool = getPool();
    // Representative row → the patient's current address (and confirms they exist).
    const [rows] = await pool.query(
      `SELECT data FROM statement_dos
       WHERE user_id = :userId AND patient_key = :key
       ORDER BY id LIMIT 1`,
      { userId, key }
    );
    if (!rows.length) return res.status(404).json({ message: 'Patient not found.' });

    const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;

    // Address validation is a one-time action per patient. If it has already run,
    // reject re-validation so it can never be triggered twice for the same patient.
    if (data.addressValidated) {
      return res.status(409).json({ message: "This patient's address has already been validated." });
    }

    const line1 = s(data.patientAddress1);
    const line2 = s(data.patientAddress2);
    const inputLines = [line1, line2].filter(Boolean);
    if (!inputLines.length) {
      return res.status(400).json({ message: 'This patient has no address on file to validate.' });
    }

    // Call Google Address Validation (server-side, bounded by a timeout).
    const payload = await validateAddress(inputLines);
    // Reaching here means Google returned 200 → a billable call. Count it toward the
    // month's usage (accurate free-tier tracking without Cloud Monitoring). Non-fatal.
    await recordApiCall('address_validation');
    // A successful Maps Platform call means the project's billing account is active
    // (unbilled keys are rejected). Derive the accurate real-time plan status.
    const apiStatus = buildApiStatus('ok', payload?.responseId);
    const validated = extractValidatedAddress(payload);
    if (!validated.line1 && !validated.line2) {
      return res.status(422).json({ message: 'The address could not be validated.' });
    }

    // Persist the standardized address to every DOS row for this patient in one
    // atomic UPDATE. A dedicated connection is opened for the transaction and is
    // always released back to the pool, even on error.
    const conn = await pool.getConnection();
    let updatedRows = 0;
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `UPDATE statement_dos
            SET data = JSON_SET(data,
                  '$.patientAddress1', :l1,
                  '$.patientAddress2', :l2,
                  '$.addressValidated', :validatedAt)
          WHERE user_id = :userId AND patient_key = :key`,
        { l1: validated.line1, l2: validated.line2, validatedAt: new Date().toISOString(), userId, key }
      );
      updatedRows = result.affectedRows || 0;
      await conn.commit();
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw err;
    } finally {
      conn.release();
    }

    await writeAudit({
      actorId: userId,
      action: 'statements.validateAddress',
      detail: `patient=${key} rows=${updatedRows} before="${inputLines.join(', ')}" after="${validated.formatted}"`,
    });

    return res.json({
      previous: { line1, line2 },
      validated: {
        line1: validated.line1,
        line2: validated.line2,
        formatted: validated.formatted,
        complete: validated.complete,
        hasUnconfirmed: validated.hasUnconfirmed,
        hasInferred: validated.hasInferred,
        verdictText: validated.verdictText,
      },
      updatedRows,
      api: apiStatus,
    });
  } catch (err) {
    // Address-validation failures carry their own HTTP status; surface the message.
    // For a billing-disabled key, include the accurate API status so the client
    // popup can report the free/no-billing plan rather than a generic error.
    if (err && err.name === 'AddressValidationError') {
      const body = { message: err.message, code: err.code || undefined };
      if (err.code === 'BILLING_DISABLED') body.api = buildApiStatus('billing_disabled');
      return res.status(err.status || 502).json(body);
    }
    next(err);
  }
}

/* --------------------------------- GET /address-validation/status (live SKU) */

/**
 * Live free-tier / SKU status for the Google Address Validation API. Reads the REAL
 * month-to-date call volume (Cloud Monitoring) and the SKU's free threshold + price
 * (Cloud Billing Catalog) and returns an accurate verdict (FREE / PAYMENT / UNKNOWN).
 * Never fabricates: figures it cannot source are returned as null. When live
 * monitoring is not configured the response says so honestly (configured:false).
 */
export async function addressValidationStatus(req, res, next) {
  try {
    // Feed the app's own month-to-date call count as the usage source when Cloud
    // Monitoring isn't configured, so the free-tier verdict is accurate today.
    const appCalls = await getMonthlyCallCount('address_validation').catch(() => null);
    const status = await getAddressValidationUsage({ appCalls });
    return res.json({ api: status });
  } catch (err) {
    next(err);
  }
}

/* --------------------------------------------------------- POST /generate */

/**
 * Generate a statement for one patient. Only DOS still pending are included —
 * previously-generated DOS are excluded — and those DOS are atomically flipped
 * to 'generated' and tied to the new statement record. Returns the file name
 * and the exact rows the client should render into the PDF.
 */
export async function generateStatement(req, res, next) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    const userId = req.user.id;
    const key = norm(req.body?.key);
    if (!key) {
      conn.release();
      return res.status(400).json({ message: 'A patient must be selected.' });
    }

    await conn.beginTransaction();

    // Lock the pending DOS for this patient so concurrent generates can't double-issue.
    const [pending] = await conn.query(
      `SELECT id, data, dos_date, account_number, patient_name
       FROM statement_dos
       WHERE user_id = :userId AND patient_key = :key AND status = 'pending'
       ORDER BY dos_date, id
       FOR UPDATE`,
      { userId, key }
    );

    if (!pending.length) {
      const [[{ total }]] = await conn.query(
        `SELECT COUNT(*) AS total FROM statement_dos WHERE user_id = :userId AND patient_key = :key`,
        { userId, key }
      );
      await conn.rollback();
      conn.release();
      if (!Number(total)) {
        return res.status(404).json({ message: 'Patient not found or has no dates of service.' });
      }
      return res.status(409).json({
        message: 'No new dates of service to generate for this patient. All DOS are already on a statement.',
      });
    }

    const sample = pending[0];
    const patientName = sample.patient_name || '';
    const accountNumber = sample.account_number || '';
    const sampleData = typeof sample.data === 'string' ? JSON.parse(sample.data) : sample.data;
    const officeName = s(sampleData?.officeName);

    // Sequence number = how many statements this patient already has + 1.
    const [[{ cnt }]] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM statements WHERE user_id = :userId AND patient_key = :key`,
      { userId, key }
    );
    const seq = Number(cnt || 0) + 1;

    // File name: "<OfficeName>_<StartDOS>_<EndDOS>.pdf" (office name compacted with
    // no spaces, dates mm-dd-yyyy). Spans the earliest → latest date of service in
    // this statement. No patient name is included.
    const dosDates = pending
      .map((r) => {
        const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        return parseDate(r.dos_date) || parseDate(d?.dateOfService);
      })
      .filter(Boolean)
      .sort((a, b) => a - b);
    // Compact the office name: strip spaces and any non-alphanumeric characters so
    // the only underscores in the file name are the field separators.
    const compact = (str) => s(str).replace(/[^a-z0-9]+/gi, '');
    const namePart = compact(officeName || accountNumber) || 'Statement';
    const fileName = dosDates.length
      ? `${namePart}_${dosStamp(dosDates[0])}_${dosStamp(dosDates[dosDates.length - 1])}.pdf`
      : `${namePart}_${stamp()}-${seq}.pdf`;

    const [ins] = await conn.query(
      `INSERT INTO statements (user_id, account_number, patient_name, patient_key, file_name, dos_count)
       VALUES (:userId, :acct, :name, :key, :file, :count)`,
      { userId, acct: accountNumber, name: patientName, key, file: fileName, count: pending.length }
    );
    const statementId = ins.insertId;

    const ids = pending.map((r) => r.id);
    await conn.query(
      `UPDATE statement_dos SET status = 'generated', statement_id = ?
       WHERE id IN (${ids.map(() => '?').join(',')})`,
      [statementId, ...ids]
    );

    await conn.commit();
    conn.release();

    const [[stmtRow]] = await pool.query(
      `SELECT id, file_name AS fileName, dos_count AS dosCount, generated_at AS generatedAt,
              patient_name AS patientName, account_number AS accountNumber
       FROM statements WHERE id = :id`,
      { id: statementId }
    );

    await writeAudit({
      actorId: userId,
      action: 'statements.generate',
      targetId: statementId,
      detail: `patient=${patientName || accountNumber} dos=${pending.length} file=${fileName}`,
    });

    const rows = pending.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
    return res.json({ statement: { ...stmtRow, storageEnabled: isS3Configured() }, rows });
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    conn.release();
    next(err);
  }
}

/* --------------------------------------------- POST /:id/pdf (archive to S3) */

const PDF_MAGIC = Buffer.from('%PDF-');

/**
 * Archive the rendered PDF for a generated statement to Amazon S3. The PDF is
 * produced pixel-for-pixel in the browser (jsPDF), so the client uploads the
 * exact bytes the user received. The raw body is delivered as application/pdf
 * (see the express.raw() parser on this route).
 *
 * Ownership is enforced (a user can only attach a PDF to their own statement),
 * the payload is validated as a real PDF, and the S3 location + size are
 * recorded on the statement row so it can later be downloaded on demand.
 */
export async function storeStatementPdf(req, res, next) {
  try {
    if (!isS3Configured()) {
      return res.status(503).json({ message: 'Statement storage is not configured on the server.' });
    }

    const userId = req.user.id;
    const statementId = Number(req.params.id);
    if (!Number.isInteger(statementId) || statementId <= 0) {
      return res.status(400).json({ message: 'A valid statement id is required.' });
    }

    const body = Buffer.isBuffer(req.body) ? req.body : null;
    if (!body || !body.length) {
      return res.status(400).json({ message: 'No PDF content was uploaded.' });
    }
    if (body.length > env.s3.maxPdfBytes) {
      return res.status(413).json({ message: 'The statement PDF is too large to store.' });
    }
    // Validate the payload really is a PDF (magic bytes) before it touches S3.
    if (!body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      return res.status(415).json({ message: 'Uploaded content is not a valid PDF.' });
    }

    const pool = getPool();
    // The statement must exist AND belong to the calling user.
    const [[stmt]] = await pool.query(
      `SELECT id, file_name AS fileName, patient_name AS patientName, account_number AS accountNumber
         FROM statements WHERE id = :id AND user_id = :userId LIMIT 1`,
      { id: statementId, userId }
    );
    if (!stmt) {
      return res.status(404).json({ message: 'Statement not found.' });
    }

    const key = buildStatementKey({ userId, statementId, fileName: stmt.fileName });
    await putStatementPdf({
      key,
      body,
      contentType: 'application/pdf',
      metadata: {
        'user-id': String(userId),
        'statement-id': String(statementId),
        'account-number': s(stmt.accountNumber),
      },
    });

    await pool.query(
      `UPDATE statements
          SET s3_bucket = :bucket, s3_key = :key, file_size = :size,
              content_type = 'application/pdf', stored_at = NOW()
        WHERE id = :id AND user_id = :userId`,
      { bucket: env.s3.bucket, key, size: body.length, id: statementId, userId }
    );

    await writeAudit({
      actorId: userId,
      action: 'statements.store',
      targetId: statementId,
      detail: `file=${stmt.fileName} bytes=${body.length} key=${key}`,
    });

    return res.json({ stored: true, statementId, fileName: stmt.fileName, size: body.length });
  } catch (err) {
    if (err instanceof S3StorageError) {
      return res.status(err.status || 502).json({ message: err.message });
    }
    next(err);
  }
}

/* ------------------------------------------ GET /:id/download (presigned S3) */

/**
 * Return a short-lived presigned S3 URL that downloads the stored statement PDF
 * as an attachment. Ownership is enforced; a statement that was never archived
 * yields 409 so the client can fall back to regenerating the PDF locally.
 */
export async function downloadStatement(req, res, next) {
  try {
    const userId = req.user.id;
    const statementId = Number(req.params.id);
    if (!Number.isInteger(statementId) || statementId <= 0) {
      return res.status(400).json({ message: 'A valid statement id is required.' });
    }

    const pool = getPool();
    const [[stmt]] = await pool.query(
      `SELECT file_name AS fileName, s3_key AS s3Key
         FROM statements WHERE id = :id AND user_id = :userId LIMIT 1`,
      { id: statementId, userId }
    );
    if (!stmt) {
      return res.status(404).json({ message: 'Statement not found.' });
    }
    if (!stmt.s3Key) {
      return res.status(409).json({
        message: 'This statement has not been archived to storage yet.',
        code: 'NOT_STORED',
      });
    }

    const url = await getPresignedDownloadUrl({ key: stmt.s3Key, fileName: stmt.fileName });

    await writeAudit({
      actorId: userId,
      action: 'statements.download',
      targetId: statementId,
      detail: `file=${stmt.fileName}`,
    });

    return res.json({ url, fileName: stmt.fileName, expiresIn: env.s3.presignExpirySeconds });
  } catch (err) {
    if (err instanceof S3StorageError) {
      return res.status(err.status || 502).json({ message: err.message });
    }
    next(err);
  }
}
