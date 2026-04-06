import { Banknote, Bell, Check, ClipboardList, CreditCard, MessageSquareText, Receipt, Sparkles, Star, Wallet, X } from 'lucide-react';
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { formatMoney } from '../../hooks/useTableSession';
import {
  BILL_PAYMENT_METHOD_OPTIONS,
  BILL_SPLIT_OPTIONS,
  formatBillPaymentMethodLabel,
  formatBillSplitChoiceLabel,
} from '../../lib/billFlow';
import { getVisibleVenueLinks } from '../../lib/venueSettings';
import DashboardActionCard from './DashboardActionCard';

const BILL_METHOD_ICON_MAP = {
  cash: Banknote,
  card: CreditCard,
  mercado_pago: Wallet,
};

const BILL_METHOD_META_COPY = {
  cash: 'Cobro en mesa',
  card: 'Terminal en mesa',
  mercado_pago: 'Pago online',
};

const BILL_METHOD_THEME_CLASS = {
  cash: 'is-cash',
  card: 'is-card',
  mercado_pago: 'is-mercado-pago',
};

const MERCADO_PAGO_MOCK_OPTIONS = [
  { value: 'approved', label: 'Approved' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' },
];

export default function TableDashboardPage() {
  const {
    tableId,
    activeOrder,
    activeOrderStatus,
    activeOrderError,
    activeOrderItemsCount,
    activeOrderSubordersCount,
    activeOrderTotal,
    activeOrderAmountDue,
    activeOrderPaymentStatus,
    activeOrderCustomerStatus,
    billPaymentMethodPreference,
    billSplitCount,
    billSplitChoiceLabel,
    cartItemsCount,
    canManageBillFlow,
    canUpdateBillSplitChoice,
    isWaiterRequested,
    isBillRequested,
    isBillAttended,
    isBillSplitLocked,
    submittingRequestType,
    canPayWithMercadoPago,
    mercadoPagoMockMode,
    mercadoPagoMockResult,
    mercadoPagoCheckoutState,
    startingMercadoPagoCheckout,
    startMercadoPagoCheckout,
    mercadoPagoActionError,
    mercadoPagoFeedback,
    submitTableRequest,
    cancelTableRequest,
    tableRequestFeedback,
    tableRequestActionError,
    orderStatusFeedback,
    venueSettings,
    clearTableRequestMessages,
    clearMercadoPagoMessages,
    clearOrderStatusFeedback,
    setMercadoPagoMockResult,
    reloadSession,
  } = useOutletContext();
  const [isBillConfirmOpen, setIsBillConfirmOpen] = useState(false);
  const [selectedBillMethod, setSelectedBillMethod] = useState(billPaymentMethodPreference || 'cash');
  const [selectedBillSplitCount, setSelectedBillSplitCount] = useState(billSplitCount || 1);

  const myOrderBadge = activeOrder ? activeOrderCustomerStatus?.badge || 'En curso' : cartItemsCount > 0 ? 'Pendiente' : '';
  const myOrderSubtitle = activeOrder
    ? `${activeOrderSubordersCount || 1} ${activeOrderSubordersCount === 1 ? 'envío' : 'envíos'} · ${activeOrderItemsCount} ${activeOrderItemsCount === 1 ? 'ítem' : 'ítems'} · ${formatMoney(activeOrderTotal)}`
    : cartItemsCount > 0
      ? `${cartItemsCount} ${cartItemsCount === 1 ? 'ítem pendiente' : 'ítems pendientes'}`
      : 'Todavía vacío';
  const myOrderHint = '';

  const shouldShowTableRequestToast = Boolean(tableRequestFeedback) || Boolean(tableRequestActionError);
  const hasTableRequestError = Boolean(tableRequestActionError);
  const feedbackTitle = hasTableRequestError
    ? 'No pudimos registrar la acción.'
    : tableRequestFeedback.toLowerCase().includes('cancel')
      ? 'Solicitud cancelada.'
      : 'Solicitud enviada.';
  const guestFeedbackLinks = getVisibleVenueLinks(venueSettings).reduce((nextLinks, link) => {
    if (link.key === 'review') {
      nextLinks.reviewUrl = link.url;
    }

    if (link.key === 'feedback') {
      nextLinks.feedbackUrl = link.url;
    }

    return nextLinks;
  }, { feedbackUrl: '', reviewUrl: '' });
  const canCancelBillRequest = isBillRequested && !isBillAttended;
  const showGuestFeedbackActions = isBillRequested;
  const hasGuestFeedbackLinks = Boolean(guestFeedbackLinks.feedbackUrl || guestFeedbackLinks.reviewUrl);
  const shouldShowMercadoPagoToast = Boolean(mercadoPagoFeedback) || Boolean(mercadoPagoActionError);
  const mercadoPagoIsError = Boolean(mercadoPagoActionError) || mercadoPagoFeedback?.type === 'error';

  const handleWaiterAction = () => {
    if (isWaiterRequested) {
      cancelTableRequest('call_waiter');
      return;
    }

    submitTableRequest('call_waiter');
  };

  const handleBillAction = () => {
    if (!canManageBillFlow) {
      return;
    }

    setSelectedBillMethod(billPaymentMethodPreference || 'cash');
    setSelectedBillSplitCount(billSplitCount || 1);
    setIsBillConfirmOpen(true);
  };

  const confirmBillRequest = async () => {
    if (isBillSplitLocked) {
      return;
    }

    const response = await submitTableRequest('request_bill', {
      preferred_payment_method: selectedBillMethod,
      split_count: selectedBillSplitCount,
    });

    if (!response) {
      return;
    }

    setIsBillConfirmOpen(false);
  };

  const billCardSubtitle = activeOrderPaymentStatus === 'paid'
    ? 'Pago registrado'
    : billPaymentMethodPreference
      ? isBillRequested
        ? `${formatBillPaymentMethodLabel(billPaymentMethodPreference)} · ${billSplitChoiceLabel ? billSplitChoiceLabel.toLowerCase() : 'cuenta sin dividir'}`
        : formatBillPaymentMethodLabel(billPaymentMethodPreference)
      : isBillRequested && billSplitChoiceLabel
        ? billSplitChoiceLabel
        : '';
  const billCardBadge = activeOrderPaymentStatus === 'paid'
    ? 'Pagado'
    : isBillAttended
      ? 'Cuenta entregada'
      : isBillRequested
        ? 'Cuenta pedida'
        : '';
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

  return (
    <main className="table-dashboard-page">
      <section className="table-dashboard-head">
        <h1>Bienvenido a {venueSettings.restaurant_name}</h1>
        {venueSettings.restaurant_subtitle && (
          <p className="table-dashboard-head-copy-muted">{venueSettings.restaurant_subtitle}</p>
        )}
        {venueSettings.contact_label && venueSettings.contact_url && (
          <div className="dashboard-feedback-actions">
            <a
              className="btn"
              href={venueSettings.contact_url}
              target="_blank"
              rel="noreferrer"
            >
              <MessageSquareText size={16} />
              {venueSettings.contact_label}
            </a>
          </div>
        )}
      </section>

      <section className="dashboard-action-grid">
        <DashboardActionCard
          emphasized
          icon={Sparkles}
          title="Explorar menú"
          subtitle="Ver la carta"
          to={`/${tableId}/menu`}
        />
        <DashboardActionCard
          icon={ClipboardList}
          title="Mi pedido"
          subtitle={myOrderSubtitle}
          badge={myOrderBadge}
          hint={myOrderHint}
          to={`/${tableId}/pedido`}
        />
        <DashboardActionCard
          icon={Bell}
          title="Llamar al mozo"
          subtitle={isWaiterRequested ? 'Tocá para cancelar el aviso' : 'Pedir ayuda'}
          topBadge={isWaiterRequested ? 'En camino' : ''}
          disabled={Boolean(submittingRequestType)}
          onClick={handleWaiterAction}
        />
        <DashboardActionCard
          icon={Receipt}
          title="Pedir la cuenta"
          subtitle={billCardSubtitle}
          badge={billCardBadge}
          hint={
            canCancelBillRequest
              ? isBillSplitLocked
                ? 'El salón ya empezó a repartir pagos. La división ya no se puede cambiar desde la mesa.'
                : 'Podés cambiar cómo querés pagar o cómo dividir la cuenta.'
              : ''
          }
          disabled={Boolean(submittingRequestType) || !canManageBillFlow}
          onClick={handleBillAction}
        />
        {(canPayWithMercadoPago || startingMercadoPagoCheckout) && (
          <DashboardActionCard
            icon={Wallet}
            title={mercadoPagoCheckoutState?.actionLabel || 'Pagar ahora'}
            subtitle={startingMercadoPagoCheckout ? 'Abriendo Mercado Pago...' : 'Mercado Pago desde el celular'}
            hint={activeOrderAmountDue > 0 ? `Saldo actual ${formatMoney(activeOrderAmountDue)}` : ''}
            disabled={Boolean(submittingRequestType) || startingMercadoPagoCheckout}
            onClick={startMercadoPagoCheckout}
          />
        )}
      </section>

      {shouldShowTableRequestToast && (
        <div
          className={`dashboard-toast glass-panel ${hasTableRequestError ? 'is-error' : 'is-success'}`}
          role="status"
          aria-live="polite"
        >
          <div className="dashboard-toast-copy">
            <strong>{feedbackTitle}</strong>
            <span>{tableRequestActionError || tableRequestFeedback}</span>
          </div>
          <button className="btn" type="button" onClick={clearTableRequestMessages} aria-label="Cerrar notificación">
            <X size={16} />
          </button>
        </div>
      )}

      {shouldShowMercadoPagoToast && (
        <div
          className={`dashboard-toast glass-panel ${mercadoPagoIsError ? 'is-error' : mercadoPagoFeedback?.type === 'success' ? 'is-success' : ''}`}
          role="status"
          aria-live="polite"
        >
          <div className="dashboard-toast-copy">
            <strong>{mercadoPagoActionError ? 'No pudimos abrir Mercado Pago.' : mercadoPagoFeedback?.title || 'Mercado Pago'}</strong>
            <span>{mercadoPagoActionError || mercadoPagoFeedback?.message}</span>
          </div>
          <button className="btn" type="button" onClick={clearMercadoPagoMessages} aria-label="Cerrar notificación">
            <X size={16} />
          </button>
        </div>
      )}

      {orderStatusFeedback && (
        <div className="toast-success">
          <Check size={22} color="white" />
          <div className="toast-success-copy">
            <strong>{orderStatusFeedback.title}</strong>
            <span>{orderStatusFeedback.message}</span>
          </div>
          <button className="btn" type="button" onClick={clearOrderStatusFeedback} aria-label="Cerrar actualización del pedido">
            <X size={16} />
          </button>
        </div>
      )}

      {activeOrderStatus === 'error' && (
        <div className="glass-panel status-card status-card-error">
          <div>
            <strong>No pudimos recuperar el pedido actual.</strong>
            <span>{activeOrderError}</span>
          </div>
          <button className="btn" type="button" onClick={reloadSession}>
            Reintentar
          </button>
        </div>
      )}

      {shouldShowMercadoPagoState && (
        <div className={`glass-panel status-card ${
          mercadoPagoCheckoutState?.isApproved
            ? 'status-card-success'
            : mercadoPagoCheckoutState?.hasFailure
              ? 'status-card-error'
              : ''
        }`}>
          <div>
            <strong>{mercadoPagoCheckoutState?.title || 'Pagar la cuenta'}</strong>
            <span>{mercadoPagoCheckoutState?.message}</span>
            {activeOrderAmountDue > 0 ? (
              <span>Saldo pendiente: {formatMoney(activeOrderAmountDue)}</span>
            ) : mercadoPagoCheckoutState?.isApproved ? (
              <span>La cuenta ya quedó saldada. El local todavía tiene que cerrar la mesa.</span>
            ) : null}
          </div>
          {mercadoPagoMockMode && activeOrderAmountDue > 0 ? (
            <div className="mercado-pago-mock-controls">
              <span className="mercado-pago-mock-label">Modo local</span>
              <div className="mercado-pago-mock-options">
                {MERCADO_PAGO_MOCK_OPTIONS.map((option) => (
                  <button
                    key={`mock-dashboard-${option.value}`}
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
          {!mercadoPagoCheckoutState?.isApproved ? (
            <button
              className="btn btn-primary"
              type="button"
              onClick={startMercadoPagoCheckout}
              disabled={startingMercadoPagoCheckout}
            >
              <Wallet size={16} />
              {startingMercadoPagoCheckout
                ? 'Abriendo Mercado Pago...'
                : mercadoPagoCheckoutState?.actionLabel || 'Pagar ahora'}
            </button>
          ) : null}
        </div>
      )}

      {showGuestFeedbackActions && (
        <section className="glass-panel dashboard-feedback-card">
          <div className="dashboard-feedback-copy">
            <strong>Gracias por visitarnos</strong>
            <span>Si querés, podés dejarnos un comentario o una reseña sobre tu experiencia.</span>
          </div>
          <div className="dashboard-feedback-actions">
            {guestFeedbackLinks.feedbackUrl ? (
              <a
                className="btn"
                href={guestFeedbackLinks.feedbackUrl}
                target="_blank"
                rel="noreferrer"
              >
                <MessageSquareText size={16} />
                Comentarios y sugerencias
              </a>
            ) : (
              <button className="btn" type="button" disabled>
                <MessageSquareText size={16} />
                Comentarios y sugerencias
              </button>
            )}
            {guestFeedbackLinks.reviewUrl ? (
              <a
                className="btn btn-primary"
                href={guestFeedbackLinks.reviewUrl}
                target="_blank"
                rel="noreferrer"
              >
                <Star size={16} />
                Dejanos tu review en Google Maps
              </a>
            ) : (
              <button className="btn btn-primary" type="button" disabled>
                <Star size={16} />
                Dejanos tu review en Google Maps
              </button>
            )}
          </div>
          {!hasGuestFeedbackLinks && (
            <span className="dashboard-feedback-note">
              Pronto vas a poder dejar comentarios y reseñas desde acá.
            </span>
          )}
        </section>
      )}

      {isBillConfirmOpen && (
        <div className="modal-overlay" role="presentation" onClick={() => setIsBillConfirmOpen(false)}>
          <div
            className="glass-panel modal-content table-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bill-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <span className="table-confirm-modal-kicker">Cobro de la mesa</span>
                <h2 id="bill-confirm-title">¿Pedir la cuenta?</h2>
                <p className="table-confirm-modal-copy">
                  Elegí cómo querés pagar y si querés dividir la cuenta antes de que el salón empiece a cobrar.
                </p>
              </div>
            </div>
            <div className="bill-method-choice-grid">
              {BILL_PAYMENT_METHOD_OPTIONS.map((option) => (
                (() => {
                  const OptionIcon = BILL_METHOD_ICON_MAP[option.value] || Wallet;

                  return (
                    <button
                      key={option.value}
                      className={`bill-method-choice ${BILL_METHOD_THEME_CLASS[option.value] || ''} ${selectedBillMethod === option.value ? 'is-selected' : ''}`}
                      type="button"
                      onClick={() => setSelectedBillMethod(option.value)}
                      disabled={Boolean(submittingRequestType)}
                    >
                      <div className="bill-method-choice-top">
                        <span className="bill-method-choice-icon">
                          <OptionIcon size={22} />
                        </span>
                        <span className="bill-method-choice-copy">
                          <strong>{option.label}</strong>
                          <span className="bill-method-choice-meta">
                            {BILL_METHOD_META_COPY[option.value] || 'Cobro'}
                          </span>
                        </span>
                        {selectedBillMethod === option.value && (
                          <span className="bill-method-choice-check" aria-hidden="true">
                            <Check size={16} />
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })()
              ))}
            </div>
            <div className="bill-split-choice-shell">
              <div className="bill-split-choice-head">
                <strong>¿Cómo quieren dividir la cuenta?</strong>
                <span>Esto deja preparada la cuenta para que el admin cobre después.</span>
              </div>
              <div className="bill-split-choice-grid">
                {BILL_SPLIT_OPTIONS.map((option) => (
                  <button
                    key={`bill-split-${option.value}`}
                    className={`bill-split-choice ${selectedBillSplitCount === option.value ? 'is-selected' : ''}`}
                    type="button"
                    onClick={() => setSelectedBillSplitCount(option.value)}
                    disabled={Boolean(submittingRequestType) || isBillSplitLocked || !canUpdateBillSplitChoice}
                  >
                    <strong>{option.label}</strong>
                    <span>{option.customer_description}</span>
                  </button>
                ))}
              </div>
              <div className="bill-split-choice-summary">
                <span>{formatBillSplitChoiceLabel(selectedBillSplitCount)}</span>
                {isBillSplitLocked ? (
                  <span className="bill-split-choice-lock">
                    Ya empezamos a cobrar esta cuenta. La división no se puede cambiar desde la mesa.
                  </span>
                ) : null}
              </div>
            </div>
            <div className="table-confirm-modal-actions">
              {canCancelBillRequest && (
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setIsBillConfirmOpen(false);
                    cancelTableRequest('request_bill');
                  }}
                  disabled={Boolean(submittingRequestType) || isBillSplitLocked}
                >
                  <X size={16} />
                  Cancelar pedido
                </button>
              )}
              <button className="btn" type="button" onClick={() => setIsBillConfirmOpen(false)} disabled={Boolean(submittingRequestType)}>
                <X size={16} />
                Cancelar
              </button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={confirmBillRequest}
                disabled={Boolean(submittingRequestType) || isBillSplitLocked}
              >
                {selectedBillMethod === 'mercado_pago' ? <Wallet size={16} /> : <Receipt size={16} />}
                {submittingRequestType === 'request_bill'
                  ? 'Guardando...'
                  : isBillRequested
                    ? selectedBillMethod === 'mercado_pago'
                      ? 'Guardar y pagar después'
                      : 'Actualizar método'
                    : selectedBillMethod === 'mercado_pago'
                      ? 'Guardar para pagar online'
                      : 'Pedir la cuenta'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
