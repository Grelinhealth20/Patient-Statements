import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import AppLayout from './components/AppLayout.jsx';
import Login from './pages/Login.jsx';
import StatementDashboard from './pages/StatementDashboard.jsx';
import StatementHome from './pages/StatementHome.jsx';
import StatementEngine from './pages/StatementEngine.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';

export default function App() {
  const { user, isSuperAdmin } = useAuth();

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
