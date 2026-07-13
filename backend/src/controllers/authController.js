import bcrypt from 'bcryptjs';
import { getPool } from '../config/db.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  accessTokenTtlSeconds,
} from '../utils/jwt.js';
import { publicUser } from '../utils/serialize.js';
import { writeAudit } from '../config/initDb.js';

async function findUserById(id) {
  const [rows] = await getPool().query(
    `SELECT * FROM users WHERE id = :id LIMIT 1`,
    { id }
  );
  return rows[0] || null;
}

function issueSession(user) {
  return {
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user),
    expiresIn: accessTokenTtlSeconds(),
    user: publicUser(user),
  };
}

/** POST /api/auth/login */
export async function login(req, res, next) {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ message: 'Username/email and password are required.' });
    }

    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT * FROM users WHERE username = :id OR email = :id LIMIT 1`,
      { id: identifier.trim() }
    );
    const user = rows[0];

    // Constant-ish response to avoid user enumeration.
    if (!user) {
      await bcrypt.compare(password, '$2a$12$0000000000000000000000000000000000000000000000000000');
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }
    if (!user.is_active) {
      return res.status(403).json({ message: 'Your account has been deactivated. Contact an administrator.' });
    }

    await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = :id`, { id: user.id });
    await writeAudit({ actorId: user.id, action: 'LOGIN', targetId: user.id, detail: 'User signed in' });

    return res.json(issueSession(user));
  } catch (err) {
    next(err);
  }
}

/** POST /api/auth/refresh — silently rotates the 40-minute access token. */
export async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(401).json({ message: 'Refresh token required.' });
    }

    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      return res.status(401).json({ message: 'Refresh token invalid or expired.', code: 'REFRESH_EXPIRED' });
    }

    const user = await findUserById(payload.sub);
    if (!user || !user.is_active || user.token_version !== payload.tv) {
      return res.status(401).json({ message: 'Session is no longer valid.', code: 'REFRESH_REVOKED' });
    }

    return res.json(issueSession(user));
  } catch (err) {
    next(err);
  }
}

/** GET /api/auth/me */
export async function me(req, res) {
  return res.json({ user: publicUser(req.user) });
}

/** POST /api/auth/logout — revokes existing tokens by bumping token_version. */
export async function logout(req, res, next) {
  try {
    await getPool().query(
      `UPDATE users SET token_version = token_version + 1 WHERE id = :id`,
      { id: req.user.id }
    );
    return res.json({ message: 'Signed out.' });
  } catch (err) {
    next(err);
  }
}

/** POST /api/auth/change-password — for the currently signed-in user. */
export async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are required.' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters.' });
    }

    const pool = getPool();
    const fresh = await findUserById(req.user.id);
    const ok = await bcrypt.compare(currentPassword, fresh.password_hash);
    if (!ok) {
      return res.status(401).json({ message: 'Current password is incorrect.' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      `UPDATE users SET password_hash = :hash, token_version = token_version + 1 WHERE id = :id`,
      { hash, id: req.user.id }
    );
    await writeAudit({ actorId: req.user.id, action: 'CHANGE_PASSWORD', targetId: req.user.id, detail: 'Self password change' });

    return res.json({ message: 'Password updated. Please sign in again.' });
  } catch (err) {
    next(err);
  }
}
