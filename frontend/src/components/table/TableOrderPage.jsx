import { CheckCircle2, ShoppingBag, Sparkles, Wallet } from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import { formatMoney } from '../../hooks/useTableSession';
import { formatBillCollectionStatusLabel, formatBillPaymentMethodLabel } from '../../lib/billFlow';
import { getSuborderLabel, getSuborderStatusDescriptor, sortSuborders } from '../../lib/suborders';
import OrderConfirmedModal from './OrderConfirmedModal';

const MERCADO_PAGO_MOCK_OPTIONS = [
  { value: 'approved', label: 'Approved' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' },
];

export default function TableOrderPage() {
  const {
    tableId,
    activeOrder,
    activeOrderSubordersCount,
    activeOrderTotal,
    activeOrderAmountPaid,
    activeOrderAmountDue,
    activeOrderPaymentStatus,
    activeOrderCustomerStatus,
    billPaymentMethodPreference,
    billCollectionStatus,
    billSplitChoiceLabel,
    canPayWithMercadoPago,
    mercadoPagoMockMode,
    mercadoPagoMockResult,
    mercadoPagoCheckoutState,
    startingMercadoPagoCheckout,
    startMercadoPagoCheckout,
    mercadoPagoActionError,
    mercadoPagoFeedback,
    orderStatusFeedback,
    activeOrderStatus,
    activeOrderError,
    menuAvailabilityFeedback,
    cart,
    cartItemsCount,
    cartTotal,
    placingOrder,
    orderError,
    orderConfirmed,
    clearOrderConfirmed,
    isDraftLocked,
    draftLockedReason,
    updateQuantity,
    updateComment,
    placeOrder,
    reloadSession,
    clearOrderStatusFeedback,
    setMercadoPagoMockResult,
  } = useOutletContext();

  const hasDraft = cartItemsCount > 0 && !isDraftLocked;
  const hasActiveOrder = Boolean(activeOrder);
  const sortedSuborders = sortSuborders(activeOrder?.suborders || []);
  const shouldShowMercadoPagoState = Boolean(
    activeOrder?.bill_requested_at
    && billPaymentMethodPreference === 'mercado_pago'
    && (
      canPayWithMercadoPago
      || mercadoPagoCheckoutState?.isApproved
      || mercadoPagoCheckoutState?.hasPendingCheckout
      || mercadoPagoCheckoutState?.hasFailure
    )
  );

  if (activeOrderStatus === 'loading' && !hasActiveOrder && !hasDraft) {
    return <div className="loader"></div>;
  }

  return (
    <div className="table-order-page">
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
          <div className="table-section-head table-section-head-order">
            <div>
              <h2>Mi pedido</h2>
              <span className="table-order-section-copy">
                Seguimiento de tus envíos y de la cuenta abierta de la mesa.
              </span>
            </div>
            <div className="table-request-card-meta-row">
              <span className="table-badge">
                {activeOrderCustomerStatus?.badge || activeOrder.status}
              </span>
              {activeOrder.bill_requested_at && (
                <span className="table-badge">Pedida</span>
              )}
              {activeOrder.bill_attended_at && (
                <span className="table-badge">Entregada</span>
              )}
              {activeOrderPaymentStatus === 'partial' && (
                <span className="table-badge">Pago parcial</span>
              )}
              {activeOrderPaymentStatus === 'paid' && (
                <span className="table-badge">Pago completo</span>
              )}
            </div>
          </div>

          <div className="table-suborders-stack">
            {sortedSuborders.map((suborder) => {
              const suborderStatus = getSuborderStatusDescriptor(suborder);

              return (
                <div className="table-suborder-card" key={`suborder-${suborder.id}`}>
                  <div className="table-suborder-card-head">
                    <div>
                      <strong>{getSuborderLabel(suborder.sequence_number)}</strong>
                      <span>{suborder.created_at ? new Date(suborder.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                    </div>
                    <span className="table-badge">
                      {suborderStatus?.badge || suborder.status}
                    </span>
                  </div>
                  <div className="cart-items-list">
                    {(suborder.items || []).map((item) => (
                      <div className="cart-item-row" key={`${suborder.id}-${item.item_id}-${item.comments || ''}`}>
                        <div className="cart-item-details">
                          <div className="cart-item-name">{item.quantity}x {item.name}</div>
                          <div className="cart-item-price">{formatMoney(item.price * item.quantity)}</div>
                          {item.comments && <div className="item-comment">"{item.comments}"</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="table-order-summary-strip">
            <div className="table-order-summary-primary">
              Cuenta abierta: {activeOrderSubordersCount || 1} {activeOrderSubordersCount === 1 ? 'envío' : 'envíos'} · {formatMoney(activeOrderTotal)}
            </div>
            {(activeOrderAmountPaid > 0 || activeOrderPaymentStatus === 'paid') && (
              <div className="table-order-summary-secondary">
                Pagado: {formatMoney(activeOrderAmountPaid)} · Saldo: {formatMoney(activeOrderAmountDue)}
              </div>
            )}
            {activeOrder.bill_requested_at && billPaymentMethodPreference && activeOrderAmountDue > 0 && (
              <div className="table-order-summary-secondary">
                Método elegido: {formatBillPaymentMethodLabel(billPaymentMethodPreference)} · {formatBillCollectionStatusLabel(billCollectionStatus)}
              </div>
            )}
            {activeOrder.bill_requested_at && billSplitChoiceLabel && (
              <div className="table-order-summary-secondary">
                {billSplitChoiceLabel}
              </div>
            )}
          </div>
          {shouldShowMercadoPagoState && (
            <div className="order-payment-cta">
              <div>
                <strong>{mercadoPagoCheckoutState?.title || 'Pagar ahora'}</strong>
                <span>
                  {mercadoPagoCheckoutState?.message || `Podés saldar la mesa online con Mercado Pago por ${formatMoney(activeOrderAmountDue)}.`}
                  {activeOrderAmountDue > 0
                    ? ` Saldo actual ${formatMoney(activeOrderAmountDue)}.`
                    : mercadoPagoCheckoutState?.isApproved
                      ? ' La cuenta ya quedó saldada.'
                  : ''}
                </span>
              </div>
              {mercadoPagoMockMode && activeOrderAmountDue > 0 ? (
                <div className="mercado-pago-mock-controls">
                  <span className="mercado-pago-mock-label">Modo local</span>
                  <div className="mercado-pago-mock-options">
                    {MERCADO_PAGO_MOCK_OPTIONS.map((option) => (
                      <button
                        key={`mock-order-${option.value}`}
                        className={`btn ${mercadoPagoMockResult === option.value ? 'btn-primary' : ''}`}
                        type="button"
                        onClick={() => setMercadoPagoMockResult(option.value)}
                        disabled={startingMercadoPagoCheckout}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {activeOrderAmountDue > 0 ? (
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={startMercadoPagoCheckout}
                  disabled={startingMercadoPagoCheckout}
                >
                  <Wallet size={18} />
                  {startingMercadoPagoCheckout
                    ? 'Abriendo Mercado Pago...'
                    : mercadoPagoCheckoutState?.actionLabel || 'Pagar ahora'}
                </button>
              ) : null}
            </div>
          )}
          {(mercadoPagoActionError || mercadoPagoFeedback) && (
            <div className={`order-inline-error ${mercadoPagoFeedback?.type === 'success' ? 'is-success' : ''}`}>
              {mercadoPagoActionError || mercadoPagoFeedback?.message}
            </div>
          )}
        </section>
      )}

      {hasActiveOrder && isDraftLocked && (
        <div className="glass-panel status-card">
          <div>
            <strong>No se pueden agregar más pedidos.</strong>
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
              {placingOrder ? 'Confirmando...' : <><Sparkles size={18} /> {hasActiveOrder ? 'Enviar adicional' : 'Confirmar pedido'}</>}
            </button>
          </div>
        </section>
      )}

      <OrderConfirmedModal isOpen={orderConfirmed} onClose={clearOrderConfirmed} />

      {orderStatusFeedback && (
        <div className="toast-success">
          <CheckCircle2 size={22} color="white" />
          <div className="toast-success-copy">
            <strong>{orderStatusFeedback.title}</strong>
            <span>{orderStatusFeedback.message}</span>
          </div>
          <button className="btn" type="button" onClick={clearOrderStatusFeedback} aria-label="Cerrar actualización del pedido">
            Cerrar
          </button>
        </div>
      )}
    </div>
  );
}
