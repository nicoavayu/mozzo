import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AdminLogin from './components/AdminLogin';
import AdminPanel from './components/AdminPanel';
import TableShell from './components/table/TableShell';
import TableDashboardPage from './components/table/TableDashboardPage';
import TableMenuPage from './components/table/TableMenuPage';
import TableOrderPage from './components/table/TableOrderPage';
import { apiRequest } from './lib/api';
import { socket } from './lib/socket';
import { clearAdminToken, getAdminToken, logoutAdminSession } from './lib/adminAuth';
import { DEFAULT_VENUE_SETTINGS, normalizeVenueSettings } from './lib/venueSettings';

function AdminRoute({ venueSettings, onVenueSettingsSaved }) {
  const [adminToken, setAdminToken] = useState(() => getAdminToken());
  const [adminTheme, setAdminTheme] = useState(() => {
    if (typeof window === 'undefined') {
      return 'dark';
    }

    return window.localStorage.getItem('mozzo-admin-theme') || 'dark';
  });

  useEffect(() => {
    window.localStorage.setItem('mozzo-admin-theme', adminTheme);
    window.document.body.classList.toggle('admin-theme-light', adminTheme === 'light');

    return () => {
      window.document.body.classList.remove('admin-theme-light');
    };
  }, [adminTheme]);

  const handleLogout = () => {
    const token = adminToken;
    Promise.resolve(token ? logoutAdminSession(token) : null).catch(() => {
      clearAdminToken();
    }).finally(() => {
      clearAdminToken();
      setAdminToken(null);
    });
  };

  if (!adminToken) {
    return (
      <AdminLogin
        onLogin={setAdminToken}
        venueSettings={venueSettings}
        theme={adminTheme}
        onToggleTheme={() => setAdminTheme((current) => (current === 'light' ? 'dark' : 'light'))}
      />
    );
  }

  return (
    <AdminPanel
      socket={socket}
      adminToken={adminToken}
      venueSettings={venueSettings}
      onVenueSettingsSaved={onVenueSettingsSaved}
      onLogout={handleLogout}
      theme={adminTheme}
      onToggleTheme={() => setAdminTheme((current) => (current === 'light' ? 'dark' : 'light'))}
    />
  );
}

function App() {
  const [venueSettings, setVenueSettings] = useState(DEFAULT_VENUE_SETTINGS);

  useEffect(() => {
    let isMounted = true;

    const fetchVenueSettings = async () => {
      try {
        const data = await apiRequest('/api/venue-settings');
        if (isMounted) {
          setVenueSettings(normalizeVenueSettings(data));
        }
      } catch {
        if (isMounted) {
          setVenueSettings(DEFAULT_VENUE_SETTINGS);
        }
      }
    };

    fetchVenueSettings();
    socket.on('venue_settings_updated', fetchVenueSettings);

    return () => {
      isMounted = false;
      socket.off('venue_settings_updated', fetchVenueSettings);
    };
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/admin" replace />} />
        <Route
          path="/admin"
          element={
            <AdminRoute
              venueSettings={venueSettings}
              onVenueSettingsSaved={(nextSettings) => setVenueSettings(normalizeVenueSettings(nextSettings))}
            />
          }
        />
        <Route path="/:tableId" element={<TableShell socket={socket} venueSettings={venueSettings} />}>
          <Route index element={<TableDashboardPage />} />
          <Route path="menu" element={<TableMenuPage />} />
          <Route path="pedido" element={<TableOrderPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
