import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const user = await login(identifier.trim(), password);
      navigate(user.role === 'super_admin' ? '/admin' : '/statements', { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to sign in. Please try again.');
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
              <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
            </svg>
          </div>
          <div className="auth-brand-text">
            <strong>Grelin Health</strong>
            <span>Statement Suite</span>
          </div>
        </div>

        <h2>Welcome back</h2>
        <p className="auth-sub">Sign in to access your workspace</p>

        {error && <div className="alert alert-error" role="alert">{error}</div>}

        <label className="field">
          <span className="field-label">Username or Email</span>
          <input
            type="text"
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="e.g. superadmin"
            required
            autoFocus
          />
        </label>

        <label className="field">
          <span className="field-label">Password</span>
          <div className="password-wrap">
            <input
              type={showPw ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
            />
            <button type="button" className="pw-toggle" onClick={() => setShowPw((v) => !v)}>
              {showPw ? 'Hide' : 'Show'}
            </button>
          </div>
        </label>

        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign In Securely'}
        </button>

        <p className="auth-foot">Protected system · Access is monitored and audited</p>
      </form>
    </div>
  );
}
