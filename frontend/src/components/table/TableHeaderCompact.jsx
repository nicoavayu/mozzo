import { ChefHat, Moon, Sun } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function TableHeaderCompact({ tableId, socketStatus, venueSettings, theme, onToggleTheme }) {
  const isLight = theme === 'light';
  const socketState = socketStatus || 'disconnected';

  return (
    <header className="table-header-compact">
      <Link to={`/${tableId}`} className="logo">
        <ChefHat size={30} color="var(--accent-color)" />
        <span>{venueSettings.restaurant_name}</span>
      </Link>
      <div className="table-header-actions">
        <button
          className="theme-toggle"
          type="button"
          onClick={onToggleTheme}
          aria-label={isLight ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro'}
          title={isLight ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro'}
        >
          {isLight ? <Moon size={16} /> : <Sun size={16} />}
          <span>{isLight ? 'Oscuro' : 'Claro'}</span>
        </button>
        <div className="table-badge-group">
          <div className={`table-status-led is-${socketState}`} title={socketState}>
            <span className="table-status-led-dot" />
          </div>
          <div className="table-badge">Mesa {tableId}</div>
        </div>
      </div>
    </header>
  );
}
