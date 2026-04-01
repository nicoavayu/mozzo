import { ChefHat, ClipboardList, House, UtensilsCrossed } from 'lucide-react';
import { Link, NavLink } from 'react-router-dom';

function getOrderBadgeLabel(activeOrder) {
  if (!activeOrder || activeOrder.closed_at) {
    return null;
  }

  if (activeOrder.status === 'ready') {
    return 'Listo';
  }

  if (activeOrder.status === 'delivered') {
    return 'En camino';
  }

  return 'En curso';
}

export default function TableHeaderCompact({ tableId, venueSettings, activeOrder }) {
  const liveBadgeLabel = getOrderBadgeLabel(activeOrder);

  return (
    <header className="table-header-compact">
      <Link to={`/${tableId}`} className="logo">
        <ChefHat size={30} color="var(--accent-color)" />
        <span>{venueSettings.restaurant_name}</span>
      </Link>
      {liveBadgeLabel && (
        <div className="table-header-live-badge" aria-live="polite">
          <span className="table-header-live-dot" aria-hidden="true" />
          <strong>{liveBadgeLabel}</strong>
        </div>
      )}
      <nav className="table-header-nav" aria-label="Navegación de mesa">
        <NavLink
          to={`/${tableId}`}
          end
          className={({ isActive }) => `table-header-link ${isActive ? 'is-active' : ''}`}
        >
          <House size={16} />
          <span>Inicio</span>
        </NavLink>
        <NavLink
          to={`/${tableId}/menu`}
          className={({ isActive }) => `table-header-link ${isActive ? 'is-active' : ''}`}
        >
          <UtensilsCrossed size={16} />
          <span>Menú</span>
        </NavLink>
        <NavLink
          to={`/${tableId}/pedido`}
          className={({ isActive }) => `table-header-link ${isActive ? 'is-active' : ''}`}
        >
          <ClipboardList size={16} />
          <span>Mi pedido</span>
        </NavLink>
      </nav>
    </header>
  );
}
