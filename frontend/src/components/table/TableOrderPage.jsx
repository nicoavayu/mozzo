import { ArrowLeft, CheckCircle, ShoppingBag, Sparkles } from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import { ACTIVE_ORDER_STATUS_LABELS, formatMoney } from '../../hooks/useTableSession';

export default function TableOrderPage() {
  const {
    tableId,
    activeOrder,
    activeOrderStatus,
    activeOrderError,
    menuAvailabilityFeedback,
    cart,
    cartItemsCount,
    cartTotal,
    placingOrder,
    orderError,
    orderConfirmed,
    isDraftLocked,
    draftLockedReason,
    updateQuantity,
    updateComment,
    placeOrder,
    reloadSession,
  } = useOutletContext();

  const hasDraft = cartItemsCount > 0 && !isDraftLocked;
  const hasActiveOrder = Boolean(activeOrder);

  if (activeOrderStatus === 'loading' && !hasActiveOrder && !hasDraft) {
    return <div className="loader"></div>;
  }

  return (
    <>
      <section className="table-page-head glass-panel">
        <Link className="btn" to={`/${tableId}`}>
          <ArrowLeft size={16} /> Inicio
        </Link>
        <div className="table-page-head-copy">
          <strong>Mi pedido</strong>
          <span>Seguimiento y borrador</span>
        </div>
        <Link className="btn" to={`/${tableId}/menu`}>
          Ver menú
        </Link>
      </section>

      {activeOrderStatus === 'error' && (
        <div className="glass-panel status-card status-card-error">
          <div>
            <strong>No pudimos recuperar el pedido activo de la mesa.</strong>
            <span>{activeOrderError}</span>
          </div>
          <button className="btn" type="button" onClick={reloadSession}>
            Reintentar
          </button>
        </div>
      )}

      {!hasActiveOrder && !hasDraft && (
        <div className="glass-panel table-empty-state">
          <ShoppingBag size={26} />
          <div>
            <strong>Todavía no agregaste platos.</strong>
            <span>Explorá el menú para empezar a armar el pedido de la mesa.</span>
          </div>
          <Link className="btn btn-primary" to={`/${tableId}/menu`}>
            Explorar menú
          </Link>
        </div>
      )}

      {menuAvailabilityFeedback && (
        <div className="glass-panel status-card status-card-error">
          <div>
            <strong>Actualizamos tu pedido.</strong>
            <span>{menuAvailabilityFeedback}</span>
          </div>
        </div>
      )}

      {hasActiveOrder && (
        <section className="glass-panel table-order-section is-live">
          <div className="table-section-head">
            <div>
              <span className="client-section-label">Pedido enviado</span>
              <h2>Pedido #{activeOrder.id}</h2>
            </div>
            <div className="table-request-card-meta-row">
              <span className="table-badge">
                {ACTIVE_ORDER_STATUS_LABELS[activeOrder.status] || activeOrder.status}
              </span>
              {activeOrder.bill_requested_at && (
                <span className="table-badge">Cuenta pedida</span>
              )}
              {activeOrder.bill_attended_at && (
                <span className="table-badge">Cuenta atendida</span>
              )}
            </div>
          </div>

          <div className="cart-items-list">
            {(activeOrder.items || []).map((item) => (
              <div className="cart-item-row" key={`${activeOrder.id}-${item.item_id}-${item.comments || ''}`}>
                <div className="cart-item-details">
                  <div className="cart-item-name">{item.quantity}x {item.name}</div>
                  <div className="cart-item-price">{formatMoney(item.price * item.quantity)}</div>
                  {item.comments && <div className="item-comment">"{item.comments}"</div>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {hasActiveOrder && (
        <div className="glass-panel status-card">
          <div>
            <strong>No podés empezar otro pedido todavía.</strong>
            <span>{draftLockedReason}</span>
          </div>
          <Link className="btn" to={`/${tableId}/menu`}>
            Ver menú
          </Link>
        </div>
      )}

      {hasDraft && (
        <section className="glass-panel table-order-section is-draft">
          <div className="table-section-head">
            <div>
              <span className="client-section-label">Borrador local</span>
              <h2>Listo para confirmar</h2>
            </div>
            <span className="table-badge">{cartItemsCount} {cartItemsCount === 1 ? 'ítem' : 'ítems'}</span>
          </div>

          <div className="cart-items-list">
            {cart.map((item) => (
              <div className="cart-item-row" key={item.id}>
                <div className="cart-item-details">
                  <div className="cart-item-name">{item.name}</div>
                  <div className="cart-item-price">{formatMoney(item.price * item.quantity)}</div>
                  <textarea
                    className="cart-comment-input"
                    placeholder="Comentarios (ej: sin cebolla)..."
                    value={item.comments}
                    onChange={(event) => updateComment(item.id, event.target.value)}
                  />
                </div>
                <div className="qty-controls">
                  <button className="qty-btn" type="button" onClick={() => updateQuantity(item.id, -1)}>
                    -
                  </button>
                  <span className="qty-display">{item.quantity}</span>
                  <button className="qty-btn" type="button" onClick={() => updateQuantity(item.id, 1)}>
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>

          {orderError && <div className="order-inline-error">{orderError}</div>}

          <div className="cart-footer">
            <div className="grand-total">Total: {formatMoney(cartTotal)}</div>
            <button className="btn btn-primary" type="button" onClick={placeOrder} disabled={placingOrder}>
              {placingOrder ? 'Confirmando...' : <><Sparkles size={18} /> Confirmar pedido</>}
            </button>
          </div>
        </section>
      )}

      {orderConfirmed && (
        <div className="toast-success">
          <CheckCircle size={22} color="white" />
          ¡Pedido enviado a cocina!
        </div>
      )}
    </>
  );
}
