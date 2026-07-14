import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { GrelinWordmark } from '../components/GrelinLogo.jsx';

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
      <form className="auth-card auth-card--center" onSubmit={submit}>
        <div className="auth-logo">
          <GrelinWordmark className="auth-wordmark" />
        </div>
        <div className="auth-eyebrow"><span>Statement Suite</span></div>

        <h2>Welcome back</h2>
        <p className="auth-sub">Sign in to access your workspace</p>

        {error && <div className="alert alert-error" role="alert">{error}</div>}

        <div className="auth-fields">
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
        </div>

        <p className="auth-foot">Protected system · Access is monitored and audited</p>
      </form>
    </div>
  );
}
