import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import Menu from './components/Menu';
import AdminPanel from './components/AdminPanel';
import { ChefHat } from 'lucide-react';
import { DEFAULT_VENUE_SETTINGS, normalizeVenueSettings } from './lib/venueSettings';

const SOCKET_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const socket = io(SOCKET_URL);
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function TableView({ venueSettings }) {
  const { tableId } = useParams();
  
  return (
    <div className="app-container">
      <header className="app-header">
        <div className="brand-block">
          <div className="logo">
            <ChefHat size={32} color="var(--accent-color)" />
            <span>{venueSettings.restaurant_name}</span>
          </div>
          {venueSettings.restaurant_subtitle && (
            <p className="brand-subtitle">{venueSettings.restaurant_subtitle}</p>
          )}
        </div>
        <div className="table-badge">Mesa {tableId}</div>
      </header>
      <Menu tableId={tableId} socket={socket} venueSettings={venueSettings} />
    </div>
  );
}

function App() {
  const [venueSettings, setVenueSettings] = useState(DEFAULT_VENUE_SETTINGS);

  useEffect(() => {
    const fetchVenueSettings = async () => {
      try {
        const response = await fetch(`${API_URL}/api/venue-settings`);
        if (!response.ok) {
          throw new Error('No pudimos cargar la configuración del local.');
        }

        const data = await response.json();
        setVenueSettings(normalizeVenueSettings(data));
      } catch {
        setVenueSettings(DEFAULT_VENUE_SETTINGS);
      }
    };

    fetchVenueSettings();
    socket.on('venue_settings_updated', fetchVenueSettings);

    return () => {
      socket.off('venue_settings_updated', fetchVenueSettings);
    };
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/admin"
          element={
            <AdminPanel
              socket={socket}
              venueSettings={venueSettings}
              onVenueSettingsSaved={(nextSettings) => {
                setVenueSettings(normalizeVenueSettings(nextSettings));
              }}
            />
          }
        />
        <Route path="/:tableId" element={<TableView venueSettings={venueSettings} />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
