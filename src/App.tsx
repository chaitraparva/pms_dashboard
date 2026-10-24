import { lazy, ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { ToastProvider, Loading } from './ui/kit';
import { Login } from './pages/Login';
import { SetPassword } from './pages/SetPassword';

const AdminApp = lazy(() => import('./admin/AdminApp'));
const PortalApp = lazy(() => import('./investor/PortalApp'));

const Splash = () => <div style={{ padding: 40, maxWidth: 640, margin: '0 auto' }}><Loading /></div>;

/** Client-side routing guard. Real protection is row-level security in the database. */
function Guard({ role, children }: { role: 'super_admin' | 'investor'; children: ReactNode }) {
  const { ready, session, profile, settings, needsMfa, signOut } = useAuth();
  const loc = useLocation();
  if (!ready) return <Splash />;
  if (!session || needsMfa) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (!profile || !settings) return <Splash />;
  if (profile.account_status !== 'active') {
    return (
      <div className="login"><section className="login-r" style={{ gridColumn: '1 / -1' }}><div className="login-box">
        <h2>Account suspended</h2><p className="hint">Your account is currently suspended. Please contact {settings.support_email || 'the administrator'}.</p>
        <button className="btn" onClick={() => signOut()}>Sign out</button>
      </div></section></div>
    );
  }
  if (profile.role !== role) return <Navigate to={profile.role === 'super_admin' ? '/admin' : '/portal'} replace />;
  return <>{children}</>;
}

function Home() {
  const { ready, session, profile, needsMfa } = useAuth();
  if (!ready || (session && !profile && !needsMfa)) return <Splash />;
  if (!session || needsMfa || !profile) return <Navigate to="/login" replace />;
  return <Navigate to={profile.role === 'super_admin' ? '/admin' : '/portal'} replace />;
}

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Suspense fallback={<Splash />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/set-password" element={<SetPassword />} />
            <Route path="/admin/*" element={<Guard role="super_admin"><AdminApp /></Guard>} />
            <Route path="/portal/*" element={<Guard role="investor"><PortalApp /></Guard>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </AuthProvider>
  );
}
