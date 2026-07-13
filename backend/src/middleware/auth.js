import { verifyAccessToken } from '../utils/jwt.js';
import { getPool } from '../config/db.js';

/**
 * Validates the bearer access token, confirms the account is still active and
 * that the token version matches the DB (so revoked tokens are rejected), and
 * attaches a fresh user snapshot to req.user.
 */
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ message: 'Authentication required.' });
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      const expired = err.name === 'TokenExpiredError';
      return res.status(401).json({
        message: expired ? 'Session expired. Please refresh.' : 'Invalid token.',
        code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      });
    }

    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, username, email, full_name, role, statement_access, is_active, token_version, must_change_password
         FROM users WHERE id = :id LIMIT 1`,
      { id: payload.sub }
    );

    const user = rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ message: 'Account is inactive or no longer exists.' });
    }
    if (user.token_version !== payload.tv) {
      return res.status(401).json({ message: 'Session revoked. Please sign in again.', code: 'TOKEN_REVOKED' });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Enterprise guard: a user carrying a temporary password (must_change_password) is
 * blocked from EVERY protected feature until they set a new password. This is enforced
 * server-side on top of the JWT check, so the forced-reset cannot be bypassed by
 * calling the API directly — only /auth/set-initial-password, /auth/me and
 * /auth/logout remain reachable while the flag is set.
 */
export function blockIfPasswordChangeRequired(req, res, next) {
  if (req.user && req.user.must_change_password) {
    return res.status(403).json({
      message: 'You must set a new password before continuing.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }
  next();
}

/** Restricts a route to super administrators only. */
export function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({ message: 'Super administrator privileges required.' });
  }
  next();
}

/** Restricts a route to users who still have Statement Generator access. */
export function requireStatementAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }
  if (req.user.role !== 'super_admin' && !req.user.statement_access) {
    return res.status(403).json({ message: 'Access to the Statement Generator has been restricted.' });
  }
  next();
}
