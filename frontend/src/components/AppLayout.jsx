import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

function Icon({ name }) {
  const paths = {
    statements: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </>
    ),
    admin: (
      <>
        <path d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6l7-3z" />
        <path d="M9.5 12l1.8 1.8L15 10" />
      </>
    ),
    logout: (
      <>
        <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
        <path d="M10 17l-5-5 5-5M4 12h11" />
      </>
    ),
    spark: (
      <>
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export default function AppLayout() {
  const { user, isSuperAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const initials = (user?.fullName || user?.username || '?')
    .split(' ')
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const handleLogout = async () => {
    setBusy(true);
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="topbar-left">
          <div className="brand">
            <div className="brand-mark"><Icon name="spark" /></div>
            <div className="brand-text">
              <strong>Grelin Health</strong>
              <span>Statement Suite</span>
            </div>
          </div>

          <nav className="topbar-nav" aria-label="Primary">
            <NavLink to="/statements" className="nav-item">
              <Icon name="statements" />
              <span>Statement Generator</span>
            </NavLink>
            {isSuperAdmin && (
              <NavLink to="/admin" className="nav-item">
                <Icon name="admin" />
                <span>Admin Panel</span>
              </NavLink>
            )}
          </nav>
        </div>

        <div className="topbar-right">
          <span className="env-tag">PRODUCTION</span>
          <span className="pulse"><span className="dot" /> All systems operational</span>
          <span className="topbar-divider" aria-hidden="true" />
          <div className="user-card">
            <div className="avatar avatar-sm">{initials}</div>
            <div className="user-meta">
              <strong>{user?.fullName || user?.username}</strong>
              <span className="role-pill">{isSuperAdmin ? 'Super Admin' : 'Operator'}</span>
            </div>
          </div>
          <button className="btn-logout" onClick={handleLogout} disabled={busy}>
            <Icon name="logout" />
            <span>{busy ? 'Signing out…' : 'Sign Out'}</span>
          </button>
        </div>
      </header>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
