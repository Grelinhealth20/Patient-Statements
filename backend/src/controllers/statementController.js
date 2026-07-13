import { getPool } from '../config/db.js';
import { writeAudit } from '../config/initDb.js';

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

/**
 * Grouped patient list for the dashboard table. Status is 'pending' when the
 * patient has any ungenerated DOS, otherwise 'generated'. The latest statement
 * supplies the shown Generated Date + File Name.
 */
export async function listPatients(req, res, next) {
  try {
    const userId = req.user.id;
    const pool = getPool();

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
       ORDER BY MAX(d.patient_name)`,
      { userId }
    );

    // Latest statement per patient_key (for generated date + file name).
    const [stmts] = await pool.query(
      `SELECT s1.patient_key AS patientKey, s1.file_name AS fileName,
              s1.generated_at AS generatedAt, s1.dos_count AS dosCount
       FROM statements s1
       JOIN (
         SELECT patient_key, MAX(id) AS maxId
         FROM statements WHERE user_id = :userId GROUP BY patient_key
       ) last ON last.maxId = s1.id
       WHERE s1.user_id = :userId`,
      { userId }
    );
    const latest = new Map(stmts.map((r) => [r.patientKey, r]));

    // One representative DOS row per patient — supplies the office + patient
    // address shown at the patient level (these are consistent across a
    // patient's dates of service).
    const [sampleRows] = await pool.query(
      `SELECT d.patient_key AS patientKey, d.data AS data
       FROM statement_dos d
       JOIN (
         SELECT patient_key, MIN(id) AS minId
         FROM statement_dos WHERE user_id = :userId GROUP BY patient_key
       ) f ON f.minId = d.id
       WHERE d.user_id = :userId`,
      { userId }
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
        dosCount: Number(r.dosCount || 0),
        pendingCount: pending,
        generatedCount: Number(r.generatedCount || 0),
        status: pending > 0 ? 'pending' : 'generated',
        lastFileName: last ? last.fileName : '',
        lastGeneratedAt: last ? last.generatedAt : null,
      };
    });

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

    // File name: "<Office Name> _ <StartDOS>_<EndDOS>.pdf" (mm-dd-yyyy), spanning
    // the earliest → latest date of service included in this statement.
    const dosDates = pending
      .map((r) => {
        const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        return parseDate(r.dos_date) || parseDate(d?.dateOfService);
      })
      .filter(Boolean)
      .sort((a, b) => a - b);
    const namePart = fsafe(officeName || patientName || accountNumber) || 'Statement';
    const fileName = dosDates.length
      ? `${namePart} _ ${dosStamp(dosDates[0])}_${dosStamp(dosDates[dosDates.length - 1])}.pdf`
      : `${namePart} _ ${stamp()}-${seq}.pdf`;

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
    return res.json({ statement: stmtRow, rows });
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    conn.release();
    next(err);
  }
}
