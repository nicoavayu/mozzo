import { ArrowRight, ClipboardList } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatMoney } from '../../hooks/useTableSession';
import { getCustomerActiveOrderStatus } from '../../lib/orderStatus';

export default function ActiveOrderMiniCard({
  tableId,
  activeOrder,
  activeOrderItemsCount,
  activeOrderTotal,
}) {
  if (!activeOrder) {
    return null;
  }

  const title = 'Pedido en curso';
  const customerStatus = getCustomerActiveOrderStatus(activeOrder.status);
  const detail = `${customerStatus.badge} · ${activeOrderItemsCount} ${activeOrderItemsCount === 1 ? 'ítem' : 'ítems'} · ${formatMoney(activeOrderTotal)}`;

  return (
    <Link className="active-order-mini-card glass-panel" to={`/${tableId}/pedido`}>
      <div className="active-order-mini-icon">
        <ClipboardList size={20} />
      </div>
      <div className="active-order-mini-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <ArrowRight size={18} />
    </Link>
  );
}
