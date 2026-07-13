import { NavLink, Outlet } from 'react-router-dom';

function TabIcon({ name }) {
  const paths = {
    dashboard: (
      <>
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </>
    ),
    engine: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M16.9 16.9l2.1 2.1M19.1 4.9l-2.1 2.1M7 16.9l-2.1 2.1" />
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

export default function StatementDashboard() {
  return (
    <div className="page">
      {/* Centered internal top navbar for the Statement Generator */}
      <nav className="snav" aria-label="Statement Generator sections">
        <div className="snav-seg">
          <NavLink to="/statements" end className="snav-tab">
            <TabIcon name="dashboard" />
            <span>Dashboard</span>
          </NavLink>
          <NavLink to="/statements/engine" className="snav-tab">
            <TabIcon name="engine" />
            <span>Statement Engine</span>
          </NavLink>
        </div>
      </nav>

      <Outlet />
    </div>
  );
}
