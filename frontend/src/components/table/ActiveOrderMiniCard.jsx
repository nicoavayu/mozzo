import { ArrowRight, ClipboardList } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ACTIVE_ORDER_STATUS_LABELS, formatMoney } from '../../hooks/useTableSession';

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
  const detail = `${ACTIVE_ORDER_STATUS_LABELS[activeOrder.status] || activeOrder.status} · ${activeOrderItemsCount} ${activeOrderItemsCount === 1 ? 'ítem' : 'ítems'} · ${formatMoney(activeOrderTotal)}`;

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
