import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Forced first-login password reset. Shown (blocking everything) whenever a signed-in
 * user still carries an admin-issued temporary password. On success the backend returns
 * a fresh session with the flag cleared, so the app proceeds to the dashboard in real
 * time. The server also blocks every protected API until this is done, so it cannot be
 * skipped.
 */
export default function ForcePasswordReset() {
  const { user, completeInitialPassword, logout } = useAuth();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = confirm.length > 0 && pw !== confirm;
  const canSubmit = pw.length >= 8 && pw === confirm && !busy;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (pw.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (pw !== confirm) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    try {
      await completeInitialPassword(pw);
      // On success the auth user updates (mustChangePassword=false) and App swaps to the
      // dashboard automatically — no navigation needed here.
    } catch (err) {
      setError(err.response?.data?.message || 'Could not set your new password. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <div className="auth-brand-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
          </div>
          <div className="auth-brand-text">
            <strong>Grelin Health</strong>
            <span>Statement Suite</span>
          </div>
        </div>

        <h2>Set your password</h2>
        <p className="auth-sub">
          {user?.fullName || user?.username ? `Welcome, ${user.fullName || user.username}. ` : ''}
          For your security, choose a new password to replace the temporary one before continuing.
        </p>

        {error && <div className="alert alert-error" role="alert">{error}</div>}

        <label className="field">
          <span className="field-label">New Password</span>
          <div className="password-wrap">
            <input
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="At least 8 characters"
              required
              autoFocus
              aria-invalid={tooShort}
            />
            <button type="button" className="pw-toggle" onClick={() => setShow((v) => !v)}>
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
          {tooShort && <span className="field-hint field-hint-warn">Must be at least 8 characters.</span>}
        </label>

        <label className="field">
          <span className="field-label">Confirm New Password</span>
          <div className="password-wrap">
            <input
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter your new password"
              required
              aria-invalid={mismatch}
            />
          </div>
          {mismatch && <span className="field-hint field-hint-warn">Passwords do not match.</span>}
        </label>

        <button className="btn-primary" type="submit" disabled={!canSubmit}>
          {busy ? 'Saving…' : 'Set Password & Continue'}
        </button>

        <button
          type="button"
          className="auth-linkbtn"
          onClick={() => logout()}
          disabled={busy}
        >
          Sign out instead
        </button>

        <p className="auth-foot">Protected system · Access is monitored and audited</p>
      </form>
    </div>
  );
}
