import { useReducer } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { Layout } from './components/Layout';
import { useFirebaseUser } from './lib/firebase';
import { useCredential } from './lib/session';
import { AccountDetail } from './pages/AccountDetail';
import { Admin } from './pages/Admin';
import { AdminLogin } from './pages/AdminLogin';
import { Dashboard } from './pages/Dashboard';
import { Landing } from './pages/Landing';
import { UserLogin } from './pages/UserLogin';
import { VerifyEmail } from './pages/VerifyEmail';

/**
 * Customer pages need a credential -- an API key chosen in this tab, or a Firebase user with a
 * verified email. Without one the visitor is sent to the user login page.
 */
function Customer({ children }: { children: React.ReactNode }) {
  const apiKey = useCredential('customerKey');
  const user = useFirebaseUser();
  const location = useLocation();
  // `user.reload()` mutates the same User object, so re-render explicitly once it is verified.
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  if (apiKey) return children;
  if (user === undefined) return <p className="text-sm text-slate-500">Restoring your session…</p>;
  if (!user) return <Navigate to="/login/user" replace state={{ from: location.pathname }} />;
  if (!user.emailVerified) return <VerifyEmail user={user} onVerified={rerender} />;
  return children;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  return useCredential('adminKey') ? children : <Navigate to="/login/admin" replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route index element={<Landing />} />
        <Route path="login/user" element={<UserLogin />} />
        <Route path="login/admin" element={<AdminLogin />} />
        <Route element={<Layout />}>
          <Route
            path="app"
            element={
              <Customer>
                <Dashboard />
              </Customer>
            }
          />
          <Route
            path="app/accounts/:id"
            element={
              <Customer>
                <AccountDetail />
              </Customer>
            }
          />
          <Route
            path="admin"
            element={
              <AdminOnly>
                <Admin />
              </AdminOnly>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
