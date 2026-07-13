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

/**
 * POST /api/auth/set-initial-password — completes the forced first-login reset.
 *
 * The caller is already authenticated (they logged in with the admin-issued temp
 * password, so their JWT is valid). They supply only a new password; on success the
 * temp-password flag is cleared, all prior tokens are revoked (token_version bumped),
 * and a BRAND-NEW session is returned so the user proceeds to the dashboard in real
 * time — no re-login. Rejects a new password identical to the temporary one.
 */
export async function setInitialPassword(req, res, next) {
  try {
    const { newPassword } = req.body;
    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters.' });
    }

    const pool = getPool();
    const fresh = await findUserById(req.user.id);
    if (!fresh) return res.status(401).json({ message: 'Account no longer exists.' });

    const same = await bcrypt.compare(newPassword, fresh.password_hash);
    if (same) {
      return res.status(400).json({ message: 'Your new password must be different from the temporary password.' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      `UPDATE users
          SET password_hash = :hash, must_change_password = 0, token_version = token_version + 1
        WHERE id = :id`,
      { hash, id: req.user.id }
    );
    await writeAudit({ actorId: req.user.id, action: 'SET_INITIAL_PASSWORD', targetId: req.user.id, detail: 'Completed forced first-login password reset' });

    // Re-read the user (cleared flag + bumped token_version) and mint a fresh session
    // so the new tokens are valid and the client can continue without signing in again.
    const updated = await findUserById(req.user.id);
    return res.json(issueSession(updated));
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
