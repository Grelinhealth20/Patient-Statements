import { getPool } from '../config/db.js';
import { env } from '../config/env.js';
import { writeAudit } from '../config/initDb.js';
import { resolvePatientAddress, isAnyUspsConfigured, probeUsps, UspsValidationError } from '../utils/addressResolver.js';
import { recordApiCall, getMonthlyCallCount } from '../utils/apiUsage.js';
import {
  isS3Configured,
  buildStatementKey,
  putStatementPdf,
  getPresignedDownloadUrl,
  getObjectBytes,
  S3StorageError,
} from '../utils/s3.js';
import { PDFDocument } from 'pdf-lib';

/* ------------------------------------------------------------------ helpers */

const s = (v) => (v == null ? '' : String(v)).trim();
const norm = (v) => s(v).toLowerCase().replace(/\s+/g, ' ');

/**
 * Row-visibility scope. A **super administrator sees and acts across ALL users'
 * statements** (organization-wide oversight); every other user is restricted to their
 * own rows exactly as before. Returns a SQL boolean fragment to drop into a WHERE
 * clause: `1=1` for admins (no restriction) or `<col> = :userId` for regular users.
 * The `:userId` param can always be supplied — it's simply ignored when unrestricted.
 */
function uidClause(req, col = 'user_id') {
  return req.user.role === 'super_admin' ? '1=1' : `${col} = :userId`;
}

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
        s(row.patientDob).slice(0, 40),
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
           (user_id, account_number, patient_name, patient_dob, patient_key, dos_date, dos_key, data, source_file)
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

    // Optional real-time search by patient name (or account number). LIKE wildcards
    // in the user's input are escaped so a literal % or _ can't broaden the match.
    const search = s(req.query.search || '').slice(0, 100);
    const likeParam = search ? `%${search.replace(/[\\%_]/g, '\\$&')}%` : null;
    const searchClause = search
      ? 'AND (d.patient_name LIKE :search OR d.account_number LIKE :search)'
      : '';

    // Aggregate totals across ALL of this user's patients (for the KPI row),
    // independent of the current page and of any active search.
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
         WHERE ${uidClause(req, 'd.user_id')}
         GROUP BY d.patient_key
       ) g`,
      { userId }
    );
    const total = Number(agg.totalPatients || 0); // overall (drives the KPI row)

    // When searching, pagination reflects only the matching patients.
    let matchTotal = total;
    if (search) {
      const [[fc]] = await pool.query(
        `SELECT COUNT(*) AS c FROM (
           SELECT d.patient_key
           FROM statement_dos d
           WHERE ${uidClause(req, 'd.user_id')} ${searchClause}
           GROUP BY d.patient_key
         ) g`,
        { userId, search: likeParam }
      );
      matchTotal = Number(fc.c || 0);
    }

    const totalPages = Math.max(1, Math.ceil(matchTotal / pageSize));
    const page = Math.min(intParam(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER), totalPages);
    const offset = (page - 1) * pageSize;

    const pagination = { page, pageSize, total: matchTotal, totalPages, search };
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
         SUM(d.status = 'generated')                     AS generatedCount,
         MAX(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(d.data, '$.addressValidationProvider')) IN ('usps','google')
                  THEN 1 ELSE 0 END)                     AS addrValidated
       FROM statement_dos d
       WHERE ${uidClause(req, 'd.user_id')} ${searchClause}
       GROUP BY d.patient_key
       ORDER BY addrValidated ASC, MAX(d.patient_name)
       LIMIT ${pageSize} OFFSET ${offset}`,
      { userId, ...(likeParam ? { search: likeParam } : {}) }
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
         FROM statements WHERE ${uidClause(req)} AND patient_key IN (${inList}) GROUP BY patient_key
       ) last ON last.maxId = s1.id
       WHERE ${uidClause(req, 's1.user_id')}`,
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
         FROM statement_dos WHERE ${uidClause(req)} AND patient_key IN (${inList}) GROUP BY patient_key
       ) f ON f.minId = d.id
       WHERE ${uidClause(req, 'd.user_id')}`,
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
        patientDob: s(data?.patientDob),
        accountNumber: r.accountNumber || '',
        officeAddress: officeAddressOf(data),
        patientAddress: patientAddressOf(data),
        addressValidated: !!(data && data.addressValidated),
        addressValidationProvider: (data && data.addressValidationProvider) || null, // 'usps' | 'google'
        addressValidatedAt: (data && data.addressValidated) || null,
        addressValidationVerdict: (data && data.addressValidationVerdict) || null,
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
       WHERE ${uidClause(req, 'd.user_id')}
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

/* --------------------------------------------------- GET /summary (financials) */

/**
 * Live financial summary for the dashboard. Returns the REAL total of outstanding
 * Patient Responsibility across all of this user's dates of service, computed by
 * summing the `patientResponsibility` amount stored on each DOS.
 *
 * Amounts are stored as free-form strings (e.g. "$23.85 "), so each value is stripped
 * of everything except digits, a decimal point and a leading minus — exactly matching
 * the client's money() parser — then summed in the database (fast, exact, no rounding
 * drift). Nothing is fabricated: rows with no amount contribute nothing. Recomputed on
 * every call, so it is always current with the imported data.
 *
 * NOTE: the cleaned value is wrapped in CONCAT('', …) before CAST — casting a
 * REGEXP_REPLACE result straight to DECIMAL drops the fraction in MySQL 8, so this
 * forces a fresh string and preserves the cents (verified against an independent sum).
 */
export async function financialSummary(req, res, next) {
  try {
    const userId = req.user.id;
    const pool = getPool();
    const [[row]] = await pool.query(
      `SELECT
         COALESCE(SUM(
           CAST(CONCAT('', NULLIF(REGEXP_REPLACE(
             JSON_UNQUOTE(JSON_EXTRACT(data, '$.patientResponsibility')), '[^0-9.-]', ''
           ), '')) AS DECIMAL(18,2))
         ), 0) AS outstanding,
         COUNT(*) AS dosCount,
         COALESCE(SUM(
           JSON_UNQUOTE(JSON_EXTRACT(data, '$.patientResponsibility')) REGEXP '[0-9]'
         ), 0) AS dosWithAmount
       FROM statement_dos
       WHERE ${uidClause(req)}`,
      { userId }
    );
    return res.json({
      patientResponsibilityOutstanding: Number(row.outstanding || 0),
      currency: 'USD',
      dosCount: Number(row.dosCount || 0),
      dosWithAmount: Number(row.dosWithAmount || 0),
      computedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------ GET /patients/address-queue (verify all) */

/**
 * Lightweight roster of every patient with their address-validation state, used to
 * drive the "Verify All Addresses" batch. Returns each patient's key, name, whether
 * their address is already USPS-verified, and whether they have an address on file —
 * so the client can validate exactly the ones that still need it, one by one.
 * Unpaginated by design (it must cover every patient, not just the current page).
 */
export async function addressQueue(req, res, next) {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT d.patient_key AS \`key\`,
              MAX(d.patient_name) AS patientName,
              MAX(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(d.data, '$.addressValidationProvider')) IN ('usps','google')
                       THEN 1 ELSE 0 END) AS validated,
              MAX(CASE WHEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(d.data, '$.patientAddress1')), '') <> ''
                         OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(d.data, '$.patientAddress2')), '') <> ''
                       THEN 1 ELSE 0 END) AS hasAddress
       FROM statement_dos d
       WHERE ${uidClause(req, 'd.user_id')}
       GROUP BY d.patient_key
       ORDER BY MAX(d.patient_name)`,
      { userId: req.user.id }
    );
    const patients = rows.map((r) => ({
      key: r.key,
      patientName: r.patientName || '',
      validated: !!Number(r.validated),
      hasAddress: !!Number(r.hasAddress),
    }));
    return res.json({
      patients,
      total: patients.length,
      unvalidated: patients.filter((p) => !p.validated).length,
    });
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
       WHERE ${uidClause(req)} AND patient_key = :key
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
 * Validate one patient's mailing address with USPS (the sole validator) and, on
 * success, persist the standardized address across ALL of that patient's DOS rows so
 * every future statement uses the corrected address.
 *
 * The existing patient address (patientAddress1 + patientAddress2) is the input.
 * USPS credentials stay server-side; the browser only sees the result.
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
       WHERE ${uidClause(req)} AND patient_key = :key
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

    // Validate the address in real time. USPS is the sole source of truth; if it
    // cannot identify the address, resolvePatientAddress throws (handled below).
    const { validated, provider, apiStatus } = await resolvePatientAddress({ line1, line2 });
    // Track this month's USPS validation volume (free; for visibility only).
    await recordApiCall('usps_validation');
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
                  '$.addressValidated', :validatedAt,
                  '$.addressValidationProvider', :provider,
                  '$.addressValidationVerdict', :verdictText)
          WHERE ${uidClause(req)} AND patient_key = :key`,
        {
          l1: validated.line1,
          l2: validated.line2,
          validatedAt: new Date().toISOString(),
          provider,                          // always 'usps'
          verdictText: validated.verdictText || '',
          userId,
          key,
        }
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
      detail: `patient=${key} provider=${provider} rows=${updatedRows} before="${inputLines.join(', ')}" after="${validated.formatted}"`,
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
      provider,             // always 'usps'
      updatedRows,
      api: apiStatus,
    });
  } catch (err) {
    // USPS validation failures carry a machine-readable code and a clear message.
    // Surface them directly so the user sees exactly why the address didn't validate
    // (not found, unconfirmed, insufficient input, USPS unavailable, etc.).
    if (err instanceof UspsValidationError) {
      const status = err.code === 'NOT_CONFIGURED' ? 503
        : err.code === 'INSUFFICIENT_INPUT' ? 400
          : (err.code === 'NOT_FOUND' || err.code === 'UNCONFIRMED') ? 422
            : err.code === 'TIMEOUT' ? 504
              : 502;
      return res.status(status).json({
        message: uspsUserMessage(err),
        code: err.code || undefined,
        provider: 'usps',
      });
    }
    next(err);
  }
}

/** Turn a USPS error code into a clear, user-facing sentence. */
function uspsUserMessage(err) {
  switch (err.code) {
    case 'NOT_FOUND':
      return 'USPS could not find this address. Please check the street, city, state and ZIP and try again.';
    case 'UNCONFIRMED':
      return 'USPS could not confirm this address is deliverable. Please verify the details (including any apartment/suite).';
    case 'INSUFFICIENT_INPUT':
      return 'Not enough address detail to validate. A street plus state and (city or ZIP) are required.';
    case 'TIMEOUT':
      return 'USPS address validation timed out. Please try again.';
    case 'NOT_CONFIGURED':
      return 'USPS address validation is not configured on the server.';
    default:
      return err.message || 'USPS could not validate this address.';
  }
}

/* ------------------------------- PUT /patients/:key/address (edit + auto-format) */

/**
 * Directly edit a patient's mailing address from the UI. The user-supplied lines are
 * run through USPS in real time and, on success, the STANDARDIZED address (properly
 * formatted, ZIP+4, DPV) is saved to every DOS row for the patient and marked
 * verified. If USPS cannot identify the edited address, the user's raw input is still
 * saved (so the edit is never lost) and the patient is marked unverified with a clear
 * note. Unlike the one-time Validate action, editing may be repeated.
 */
export async function updatePatientAddress(req, res, next) {
  try {
    const userId = req.user.id;
    const key = norm(req.params.key);
    if (!key) return res.status(400).json({ message: 'A patient must be specified.' });

    const line1 = s(req.body?.line1);
    const line2 = s(req.body?.line2);
    if (!line1 && !line2) {
      return res.status(400).json({ message: 'Please enter an address to save.' });
    }

    const pool = getPool();
    const [[exists]] = await pool.query(
      `SELECT 1 AS ok FROM statement_dos WHERE ${uidClause(req)} AND patient_key = :key LIMIT 1`,
      { userId, key }
    );
    if (!exists) return res.status(404).json({ message: 'Patient not found.' });

    // Auto-format via USPS. On success save the standardized address + mark verified;
    // on a USPS miss keep the raw edit so nothing is lost (unverified).
    let saved = { line1, line2 };
    let validated = false;
    let provider = null;
    let verdictText = null;
    let apiStatus = null;
    let uspsError = null;
    try {
      const r = await resolvePatientAddress({ line1, line2 });
      saved = { line1: r.validated.line1, line2: r.validated.line2 };
      validated = true;
      provider = r.provider;                 // 'usps'
      verdictText = r.validated.verdictText || '';
      apiStatus = r.apiStatus;
      await recordApiCall('usps_validation');
    } catch (err) {
      if (!(err instanceof UspsValidationError)) throw err;
      uspsError = uspsUserMessage(err);       // keep the raw edit; save unverified
    }

    // Persist to every DOS row for this patient, atomically.
    const conn = await pool.getConnection();
    let updatedRows = 0;
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `UPDATE statement_dos
            SET data = JSON_SET(data,
                  '$.patientAddress1', :l1,
                  '$.patientAddress2', :l2,
                  '$.addressValidated', :validatedAt,
                  '$.addressValidationProvider', :provider,
                  '$.addressValidationVerdict', :verdictText)
          WHERE ${uidClause(req)} AND patient_key = :key`,
        {
          l1: saved.line1,
          l2: saved.line2,
          validatedAt: validated ? new Date().toISOString() : null,
          provider: validated ? provider : null,
          verdictText: validated ? verdictText : null,
          userId,
          key,
        }
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
      action: 'statements.editAddress',
      detail: `patient=${key} rows=${updatedRows} validated=${validated} saved="${[saved.line1, saved.line2].filter(Boolean).join(', ')}"`,
    });

    return res.json({
      saved,
      validated,
      provider,
      verdictText,
      updatedRows,
      uspsError,
      message: validated
        ? 'Address formatted by USPS and saved.'
        : (uspsError ? `Saved your address. ${uspsError}` : 'Address saved (not USPS-verified).'),
      api: apiStatus,
    });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------ GET /address-validation/status (live provider) */

/**
 * Live address-validation provider status for the client pill/popup. USPS is the ONLY
 * validator; its health is probed live so the pill reflects what USPS is ACTUALLY
 * doing right now, never a fabricated state. USPS address validation is free of charge.
 */
export async function addressValidationStatus(req, res, next) {
  try {
    const uspsCalls = await getMonthlyCallCount('usps_validation').catch(() => null);

    const health = isAnyUspsConfigured()
      ? await probeUsps().catch((e) => ({ configured: true, healthy: false, reason: e.message }))
      : { configured: false, healthy: false, reason: 'USPS is not configured.' };

    const api = {
      provider: 'USPS Addresses API v3',
      primary: 'usps',
      uspsPath: 'v3',
      configured: !!health.configured,
      uspsHealthy: !!health.healthy,
      live: !!health.healthy,
      verdict: 'FREE',            // USPS address validation carries no per-call charge
      planLabel: 'USPS — free (no per-call charge)',
      uspsCallsThisMonth: uspsCalls,
      reason: health.healthy ? null : (health.reason || null),
      note: health.healthy
        ? 'USPS is the sole address validator (free, real-time).'
        : (health.configured
          ? `USPS is configured but not serving right now (${health.reason || 'unavailable'}).`
          : 'USPS address validation is not configured on the server.'),
      checkedAt: health.checkedAt || new Date().toISOString(),
    };

    return res.json({ api });
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
  // Release exactly once. Post-commit work below runs on the pool (not `conn`), so
  // if it throws after the connection is released, the catch must NOT release again
  // — a double-release corrupts the pool. This guard makes release idempotent.
  let released = false;
  const releaseConn = () => { if (!released) { released = true; conn.release(); } };
  try {
    const userId = req.user.id;
    const key = norm(req.body?.key);
    if (!key) {
      releaseConn();
      return res.status(400).json({ message: 'A patient must be selected.' });
    }

    await conn.beginTransaction();

    // Lock the pending DOS for this patient so concurrent generates can't double-issue.
    const [pending] = await conn.query(
      `SELECT id, data, dos_date, account_number, patient_name, user_id
       FROM statement_dos
       WHERE ${uidClause(req)} AND patient_key = :key AND status = 'pending'
       ORDER BY dos_date, id
       FOR UPDATE`,
      { userId, key }
    );

    if (!pending.length) {
      const [[{ total }]] = await conn.query(
        `SELECT COUNT(*) AS total FROM statement_dos WHERE ${uidClause(req)} AND patient_key = :key`,
        { userId, key }
      );
      await conn.rollback();
      releaseConn();
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
    // The statement is attributed to the patient's OWNER (the user who imported the
    // DOS), not necessarily the caller — so a super admin generating on behalf of a
    // user keeps ownership/visibility consistent for everyone.
    const ownerId = sample.user_id;
    const sampleData = typeof sample.data === 'string' ? JSON.parse(sample.data) : sample.data;
    const officeName = s(sampleData?.officeName);

    // Sequence number = how many statements this patient already has + 1.
    const [[{ cnt }]] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM statements WHERE ${uidClause(req)} AND patient_key = :key`,
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
       VALUES (:ownerId, :acct, :name, :key, :file, :count)`,
      { ownerId, acct: accountNumber, name: patientName, key, file: fileName, count: pending.length }
    );
    const statementId = ins.insertId;

    const ids = pending.map((r) => r.id);
    await conn.query(
      `UPDATE statement_dos SET status = 'generated', statement_id = ?
       WHERE id IN (${ids.map(() => '?').join(',')})`,
      [statementId, ...ids]
    );

    await conn.commit();
    releaseConn();

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
    // Only roll back + release if we haven't already committed and released.
    if (!released) {
      try { await conn.rollback(); } catch { /* ignore */ }
      releaseConn();
    }
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
    // The statement must exist AND be visible to the caller (own row, or any row for a
    // super admin). The S3 key is namespaced under the statement's OWNER for consistency.
    const [[stmt]] = await pool.query(
      `SELECT id, user_id AS ownerId, file_name AS fileName, patient_name AS patientName, account_number AS accountNumber
         FROM statements WHERE id = :id AND ${uidClause(req)} LIMIT 1`,
      { id: statementId, userId }
    );
    if (!stmt) {
      return res.status(404).json({ message: 'Statement not found.' });
    }

    const key = buildStatementKey({ userId: stmt.ownerId, statementId, fileName: stmt.fileName });
    await putStatementPdf({
      key,
      body,
      contentType: 'application/pdf',
      metadata: {
        'user-id': String(stmt.ownerId),
        'statement-id': String(statementId),
        'account-number': s(stmt.accountNumber),
      },
    });

    await pool.query(
      `UPDATE statements
          SET s3_bucket = :bucket, s3_key = :key, file_size = :size,
              content_type = 'application/pdf', stored_at = NOW()
        WHERE id = :id AND ${uidClause(req)}`,
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

/* --------------------------------------------- POST /:id/merge (append PDF) */

// A combined statement (statement + attached documents) can exceed a single
// generated PDF, so the merged result gets a higher ceiling than one upload.
const MERGE_MAX_BYTES = Math.max(env.s3.maxPdfBytes * 3, 64 * 1024 * 1024);

/**
 * Append an uploaded PDF to a generated statement's stored PDF and re-store the
 * combined document under the SAME S3 key and file name — so the statement keeps
 * its exact name and download link. The statement's pages come first, then the
 * uploaded document's pages, preserving page order.
 *
 * The current stored PDF is fetched from S3 server-side (no browser CORS needed)
 * and merged with pdf-lib. Ownership is enforced and the payload is validated as a
 * real PDF. Call once per additional file (the client sends them in order); each
 * call appends to the growing document.
 */
export async function mergeStatementPdf(req, res, next) {
  try {
    if (!isS3Configured()) {
      return res.status(503).json({ message: 'Statement storage is not configured on the server.' });
    }
    const userId = req.user.id;
    const statementId = Number(req.params.id);
    if (!Number.isInteger(statementId) || statementId <= 0) {
      return res.status(400).json({ message: 'A valid statement id is required.' });
    }
    const upload = Buffer.isBuffer(req.body) ? req.body : null;
    if (!upload || !upload.length) {
      return res.status(400).json({ message: 'No PDF content was uploaded.' });
    }
    if (!upload.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      return res.status(415).json({ message: 'Uploaded content is not a valid PDF.' });
    }

    const pool = getPool();
    const [[stmt]] = await pool.query(
      `SELECT id, user_id AS ownerId, file_name AS fileName, s3_key AS s3Key, account_number AS accountNumber
         FROM statements WHERE id = :id AND ${uidClause(req)} LIMIT 1`,
      { id: statementId, userId }
    );
    if (!stmt) {
      return res.status(404).json({ message: 'Statement not found.' });
    }
    if (!stmt.s3Key) {
      return res.status(409).json({
        message: 'This statement has not been archived yet — generate it before combining documents.',
        code: 'NOT_STORED',
      });
    }

    // Fetch the current stored statement PDF, then append the uploaded document.
    const baseBytes = await getObjectBytes(stmt.s3Key);
    let mergedBuffer;
    let addedPages;
    try {
      const base = await PDFDocument.load(baseBytes, { ignoreEncryption: true });
      const add = await PDFDocument.load(upload, { ignoreEncryption: true });
      const pages = await base.copyPages(add, add.getPageIndices());
      pages.forEach((pg) => base.addPage(pg));
      addedPages = pages.length;
      mergedBuffer = Buffer.from(await base.save());
    } catch {
      return res.status(422).json({ message: 'Could not read the uploaded PDF — it may be corrupt or password-protected.' });
    }

    if (mergedBuffer.length > MERGE_MAX_BYTES) {
      return res.status(413).json({ message: 'The combined document is too large to store.' });
    }

    // Write the combined PDF back to the SAME key → same download, same file name.
    await putStatementPdf({
      key: stmt.s3Key,
      body: mergedBuffer,
      contentType: 'application/pdf',
      metadata: {
        'user-id': String(stmt.ownerId),
        'statement-id': String(statementId),
        'account-number': s(stmt.accountNumber),
        merged: '1',
      },
    });
    await pool.query(
      `UPDATE statements SET file_size = :size, stored_at = NOW() WHERE id = :id AND ${uidClause(req)}`,
      { size: mergedBuffer.length, id: statementId, userId }
    );
    await writeAudit({
      actorId: userId,
      action: 'statements.merge',
      targetId: statementId,
      detail: `file=${stmt.fileName} addedPages=${addedPages} bytes=${mergedBuffer.length}`,
    });

    return res.json({ merged: true, statementId, fileName: stmt.fileName, size: mergedBuffer.length, addedPages });
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
         FROM statements WHERE id = :id AND ${uidClause(req)} LIMIT 1`,
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
