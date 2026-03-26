import { ArrowRight, ClipboardList } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ACTIVE_ORDER_STATUS_LABELS, formatMoney } from '../../hooks/useTableSession';

export default function FloatingOrderDock({
  tableId,
  activeOrder,
  activeOrderItemsCount,
  cartItemsCount,
  cartTotal,
}) {
  if (!activeOrder && cartItemsCount === 0) {
    return null;
  }

  return (
    <div className="order-dock-wrapper">
      <Link className="order-dock" to={`/${tableId}/pedido`}>
        <div className="order-dock-main">
          <div className="order-dock-icon">
            <ClipboardList size={20} />
          </div>
          <div className="order-dock-copy">
            <strong>Mi pedido</strong>
            <span>
              {activeOrder
                ? 'Seguimiento del pedido enviado y del borrador local.'
                : 'Revisá el borrador antes de enviarlo.'}
            </span>
            <div className="order-dock-tags">
              {activeOrder && (
                <span className="order-dock-tag is-live">
                  En curso · {ACTIVE_ORDER_STATUS_LABELS[activeOrder.status] || activeOrder.status} · {activeOrderItemsCount}
                </span>
              )}
              {cartItemsCount > 0 && (
                <span className="order-dock-tag is-draft">
                  Borrador · {cartItemsCount} · {formatMoney(cartTotal)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="order-dock-action">
          <span>Ver</span>
          <ArrowRight size={18} />
        </div>
      </Link>
    </div>
  );
}
