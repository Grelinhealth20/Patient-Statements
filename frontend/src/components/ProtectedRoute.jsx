import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function ProtectedRoute({ children, requireSuperAdmin = false }) {
  const { user, isSuperAdmin, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="route-splash">
        <div className="spinner" />
        <p>Loading workspace…</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (requireSuperAdmin && !isSuperAdmin) {
    return <Navigate to="/statements" replace />;
  }

  return children;
}
