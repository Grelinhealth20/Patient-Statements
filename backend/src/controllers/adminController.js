import bcrypt from 'bcryptjs';
import { getPool } from '../config/db.js';
import { publicUser } from '../utils/serialize.js';
import { writeAudit } from '../config/initDb.js';
import { deleteAllStatementObjects, isS3Configured } from '../utils/s3.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WIPE_PHRASE = 'DELETE ALL';

async function getUserRow(id) {
  const [rows] = await getPool().query(`SELECT * FROM users WHERE id = :id LIMIT 1`, { id });
  return rows[0] || null;
}

/** GET /api/admin/users */
export async function listUsers(req, res, next) {
  try {
    const [rows] = await getPool().query(
      `SELECT * FROM users ORDER BY created_at DESC`
    );
    return res.json({ users: rows.map(publicUser) });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/stats — small summary for the admin dashboard header. */
export async function stats(req, res, next) {
  try {
    const pool = getPool();
    const [[counts]] = await pool.query(`
      SELECT
        COUNT(*)                                            AS total,
        SUM(role = 'super_admin')                           AS superAdmins,
        SUM(is_active = 1)                                  AS active,
        SUM(statement_access = 1 AND role <> 'super_admin') AS withStatementAccess
      FROM users
    `);
    return res.json({
      stats: {
        total: Number(counts.total || 0),
        superAdmins: Number(counts.superAdmins || 0),
        active: Number(counts.active || 0),
        withStatementAccess: Number(counts.withStatementAccess || 0),
      },
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/users */
export async function createUser(req, res, next) {
  try {
    const { username, email, fullName, password, role, statementAccess } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Username, email and password are required.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'A valid email address is required.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    }
    const normalizedRole = role === 'super_admin' ? 'super_admin' : 'user';

    const pool = getPool();
    const [dupes] = await pool.query(
      `SELECT id FROM users WHERE username = :u OR email = :e LIMIT 1`,
      { u: username.trim(), e: email.trim() }
    );
    if (dupes.length) {
      return res.status(409).json({ message: 'A user with that username or email already exists.' });
    }

    const hash = await bcrypt.hash(password, 12);
    // The admin-supplied password is TEMPORARY: force the user to set their own on
    // first login before they can access anything (must_change_password = 1).
    const [result] = await pool.query(
      `INSERT INTO users (username, email, full_name, password_hash, role, statement_access, is_active, must_change_password)
       VALUES (:username, :email, :fullName, :hash, :role, :access, 1, 1)`,
      {
        username: username.trim(),
        email: email.trim(),
        fullName: (fullName || '').trim(),
        hash,
        role: normalizedRole,
        access: statementAccess === false ? 0 : 1,
      }
    );

    await writeAudit({ actorId: req.user.id, action: 'CREATE_USER', targetId: result.insertId, detail: `Created ${username}` });
    const row = await getUserRow(result.insertId);
    return res.status(201).json({ user: publicUser(row) });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/admin/users/:id */
export async function updateUser(req, res, next) {
  try {
    const id = Number(req.params.id);
    const target = await getUserRow(id);
    if (!target) return res.status(404).json({ message: 'User not found.' });

    const { email, fullName, role, statementAccess, isActive } = req.body;

    // Guard: never allow the last super admin to be demoted / deactivated.
    if (target.role === 'super_admin' && (role === 'user' || isActive === false)) {
      const [[{ n }]] = await getPool().query(
        `SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND is_active = 1`
      );
      if (Number(n) <= 1) {
        return res.status(409).json({ message: 'Cannot demote or deactivate the last active super administrator.' });
      }
    }

    if (email && !EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'A valid email address is required.' });
    }
    if (email) {
      const [dupes] = await getPool().query(
        `SELECT id FROM users WHERE email = :e AND id <> :id LIMIT 1`,
        { e: email.trim(), id }
      );
      if (dupes.length) return res.status(409).json({ message: 'That email is already in use.' });
    }

    const fields = [];
    const params = { id };
    if (email !== undefined) { fields.push('email = :email'); params.email = email.trim(); }
    if (fullName !== undefined) { fields.push('full_name = :fullName'); params.fullName = (fullName || '').trim(); }
    if (role !== undefined) { fields.push('role = :role'); params.role = role === 'super_admin' ? 'super_admin' : 'user'; }
    if (statementAccess !== undefined) { fields.push('statement_access = :access'); params.access = statementAccess ? 1 : 0; }
    if (isActive !== undefined) { fields.push('is_active = :active'); params.active = isActive ? 1 : 0; }

    if (!fields.length) {
      return res.status(400).json({ message: 'No changes supplied.' });
    }

    // Any change to access / role / active status revokes existing sessions.
    fields.push('token_version = token_version + 1');

    await getPool().query(`UPDATE users SET ${fields.join(', ')} WHERE id = :id`, params);
    await writeAudit({ actorId: req.user.id, action: 'UPDATE_USER', targetId: id, detail: `Updated ${target.username}` });

    const row = await getUserRow(id);
    return res.json({ user: publicUser(row) });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/admin/users/:id/access — dedicated toggle for Statement access. */
export async function setStatementAccess(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { statementAccess } = req.body;
    const target = await getUserRow(id);
    if (!target) return res.status(404).json({ message: 'User not found.' });

    await getPool().query(
      `UPDATE users SET statement_access = :access, token_version = token_version + 1 WHERE id = :id`,
      { access: statementAccess ? 1 : 0, id }
    );
    await writeAudit({
      actorId: req.user.id,
      action: statementAccess ? 'GRANT_ACCESS' : 'RESTRICT_ACCESS',
      targetId: id,
      detail: `Statement access ${statementAccess ? 'granted' : 'restricted'} for ${target.username}`,
    });

    const row = await getUserRow(id);
    return res.json({ user: publicUser(row) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/users/:id/reset-password */
export async function resetPassword(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { newPassword } = req.body;
    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters.' });
    }
    const target = await getUserRow(id);
    if (!target) return res.status(404).json({ message: 'User not found.' });

    const hash = await bcrypt.hash(newPassword, 12);
    // An admin reset issues a TEMPORARY password: revoke existing sessions and force the
    // user to set a new password on their next login (must_change_password = 1).
    await getPool().query(
      `UPDATE users SET password_hash = :hash, token_version = token_version + 1, must_change_password = 1 WHERE id = :id`,
      { hash, id }
    );
    await writeAudit({ actorId: req.user.id, action: 'RESET_PASSWORD', targetId: id, detail: `Reset password for ${target.username}` });

    return res.json({ message: `Password reset for ${target.username}. They will be asked to set a new password at next login.` });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/wipe-all — DESTRUCTIVE. Permanently deletes ALL patient statement
 * data (statement_dos, statements, usage counters) and every stored PDF in S3.
 *
 * Deliberately preserves USER ACCOUNTS and the AUDIT LOG so the application keeps
 * working (everyone can still sign in) and the wipe itself stays accountable.
 * Guarded three ways: super-admin only (route middleware), a typed confirmation
 * phrase, and a full audit record.
 */
export async function wipeAllData(req, res, next) {
  try {
    const confirm = String(req.body?.confirm ?? '').trim();
    if (confirm !== WIPE_PHRASE) {
      return res.status(400).json({
        message: `Confirmation required. Type "${WIPE_PHRASE}" exactly to permanently wipe all data.`,
        code: 'CONFIRM_REQUIRED',
      });
    }

    const pool = getPool();
    // Snapshot the volume being destroyed (for the response + audit trail).
    const [[{ dos }]] = await pool.query('SELECT COUNT(*) AS dos FROM statement_dos');
    const [[{ stmts }]] = await pool.query('SELECT COUNT(*) AS stmts FROM statements');

    // 1) Wipe stored PDFs from S3 (best-effort — a storage error must not leave the
    //    DB half-wiped, so it's reported but doesn't abort the DB purge).
    let s3ObjectsDeleted = 0;
    let s3Error = null;
    try {
      const r = await deleteAllStatementObjects();
      s3ObjectsDeleted = r.deleted;
    } catch (err) {
      s3Error = err.message;
    }

    // 2) Purge all statement/business data. Users + audit_logs are intentionally kept.
    await pool.query('DELETE FROM statement_dos');
    await pool.query('DELETE FROM statements');
    await pool.query('DELETE FROM api_usage_monthly');

    await writeAudit({
      actorId: req.user.id,
      action: 'WIPE_ALL_DATA',
      detail: `Purged all data: statement_dos=${dos} statements=${stmts} s3Objects=${s3ObjectsDeleted}${s3Error ? ` s3Error=${s3Error}` : ''}`,
    });

    return res.json({
      wiped: true,
      statementDosDeleted: Number(dos),
      statementsDeleted: Number(stmts),
      s3Configured: isS3Configured(),
      s3ObjectsDeleted,
      s3Error,
      message: 'All patient statement data and stored PDFs have been permanently deleted. User accounts are unaffected.',
    });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/admin/users/:id */
export async function deleteUser(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) {
      return res.status(409).json({ message: 'You cannot delete your own account.' });
    }
    const target = await getUserRow(id);
    if (!target) return res.status(404).json({ message: 'User not found.' });

    if (target.role === 'super_admin') {
      const [[{ n }]] = await getPool().query(
        `SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND is_active = 1`
      );
      if (Number(n) <= 1) {
        return res.status(409).json({ message: 'Cannot delete the last active super administrator.' });
      }
    }

    await getPool().query(`DELETE FROM users WHERE id = :id`, { id });
    await writeAudit({ actorId: req.user.id, action: 'DELETE_USER', targetId: id, detail: `Deleted ${target.username}` });

    return res.json({ message: `${target.username} has been deleted.` });
  } catch (err) {
    next(err);
  }
}
