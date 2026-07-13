import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import AppLayout from './components/AppLayout.jsx';
import Login from './pages/Login.jsx';
import StatementDashboard from './pages/StatementDashboard.jsx';
import StatementHome from './pages/StatementHome.jsx';
import StatementEngine from './pages/StatementEngine.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import ForcePasswordReset from './pages/ForcePasswordReset.jsx';

export default function App() {
  const { user, isSuperAdmin, mustChangePassword } = useAuth();

  // Forced first-login reset: a signed-in user carrying a temporary password must set a
  // new one before anything else. The backend also blocks all protected APIs until then,
  // so this cannot be bypassed — it's the UI half of a server-enforced rule.
  if (user && mustChangePassword) {
    return <ForcePasswordReset />;
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/statements" replace /> : <Login />}
      />

      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/statements" element={<StatementDashboard />}>
          <Route index element={<StatementHome />} />
          <Route path="engine" element={<StatementEngine />} />
        </Route>
        <Route
          path="/admin"
          element={
            <ProtectedRoute requireSuperAdmin>
              <AdminDashboard />
            </ProtectedRoute>
          }
        />
      </Route>

      <Route
        path="/"
        element={<Navigate to={isSuperAdmin ? '/admin' : '/statements'} replace />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
