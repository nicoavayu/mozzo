import { ArrowRight, ClipboardList } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatMoney } from '../../hooks/useTableSession';
import { getCustomerActiveOrderStatus } from '../../lib/orderStatus';

export default function FloatingOrderDock({
  tableId,
  activeOrder,
  activeOrderItemsCount,
  cart,
  cartItemsCount,
  cartTotal,
}) {
  if (cartItemsCount === 0) {
    return null;
  }

  const customerStatus = activeOrder ? getCustomerActiveOrderStatus(activeOrder.status) : null;
  const firstCartItem = Array.isArray(cart) && cart.length > 0 ? cart[0] : null;
  const extraItemsCount = Array.isArray(cart) && cart.length > 1 ? cart.length - 1 : 0;
  const draftHeadline = firstCartItem
    ? `${firstCartItem.quantity}x ${firstCartItem.name}`
    : `${cartItemsCount} ${cartItemsCount === 1 ? 'producto' : 'productos'}`;
  const draftSecondary = extraItemsCount > 0
    ? `+${extraItemsCount} ${extraItemsCount === 1 ? 'producto más' : 'productos más'} · ${formatMoney(cartTotal)}`
    : formatMoney(cartTotal);

  return (
    <div className="order-dock-wrapper">
      <Link className="order-dock order-dock-summary" to={`/${tableId}/pedido`}>
        <div className="order-dock-main">
          <div className="order-dock-icon">
            <ClipboardList size={20} />
          </div>
          <div className="order-dock-copy">
            <strong>{draftHeadline}</strong>
            <span>{draftSecondary}</span>
            <div className="order-dock-tags">
              {activeOrder && (
                <span className="order-dock-tag is-live">
                  {customerStatus?.badge || 'En curso'} · {activeOrderItemsCount}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="order-dock-action">
          <span>Mi pedido</span>
          <ArrowRight size={18} />
        </div>
      </Link>
    </div>
  );
}
