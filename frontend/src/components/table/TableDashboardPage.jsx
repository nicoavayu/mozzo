import { Bell, ClipboardList, MessageSquareText, Receipt, Sparkles, Star, X } from 'lucide-react';
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { formatMoney } from '../../hooks/useTableSession';
import { getVisibleVenueLinks } from '../../lib/venueSettings';
import DashboardActionCard from './DashboardActionCard';

export default function TableDashboardPage() {
  const {
    tableId,
    activeOrder,
    activeOrderStatus,
    activeOrderError,
    activeOrderItemsCount,
    activeOrderTotal,
    cartItemsCount,
    canRequestBill,
    isWaiterRequested,
    isBillRequested,
    isBillAttended,
    submittingRequestType,
    submitTableRequest,
    cancelTableRequest,
    tableRequestFeedback,
    tableRequestActionError,
    venueSettings,
    clearTableRequestMessages,
    reloadSession,
  } = useOutletContext();
  const [isBillConfirmOpen, setIsBillConfirmOpen] = useState(false);

  const myOrderBadge = activeOrder ? 'En curso' : cartItemsCount > 0 ? 'Pendiente' : '';
  const myOrderSubtitle = activeOrder
    ? `${activeOrderItemsCount} ${activeOrderItemsCount === 1 ? 'ítem' : 'ítems'} · ${formatMoney(activeOrderTotal)}`
    : cartItemsCount > 0
      ? `${cartItemsCount} ${cartItemsCount === 1 ? 'ítem pendiente' : 'ítems pendientes'}`
      : 'Todavía vacío';
  const myOrderHint = activeOrder && cartItemsCount > 0
    ? `${cartItemsCount} ${cartItemsCount === 1 ? 'ítem' : 'ítems'} en borrador`
    : '';

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

  const handleWaiterAction = () => {
    if (isWaiterRequested) {
      cancelTableRequest('call_waiter');
      return;
    }

    submitTableRequest('call_waiter');
  };

  const handleBillAction = () => {
    if (canCancelBillRequest) {
      cancelTableRequest('request_bill');
      return;
    }

    if (!canRequestBill) {
      return;
    }

    setIsBillConfirmOpen(true);
  };

  const confirmBillRequest = () => {
    setIsBillConfirmOpen(false);
    submitTableRequest('request_bill');
  };

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
          subtitle={isBillAttended ? 'Cuenta entregada' : canCancelBillRequest ? 'Tocá para cancelar el pedido' : isBillRequested ? 'Cuenta pedida' : ''}
          hint={
            !canRequestBill && !canCancelBillRequest
              ? 'Necesitás un pedido enviado'
              : canCancelBillRequest
                ? 'Podés cancelarlo si fue un error y todavía no lo atendieron.'
              : ''
          }
          badge={isBillAttended ? 'Entregada' : isBillRequested ? 'Solicitada' : ''}
          disabled={Boolean(submittingRequestType) || isBillAttended || (!canRequestBill && !canCancelBillRequest)}
          onClick={handleBillAction}
        />
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
                <h2 id="bill-confirm-title">¿Pedir la cuenta?</h2>
                <p className="table-confirm-modal-copy">
                  Le vamos a avisar al salón que querés cerrar la mesa.
                </p>
              </div>
            </div>
            <div className="table-confirm-modal-actions">
              <button className="btn" type="button" onClick={() => setIsBillConfirmOpen(false)}>
                Cancelar
              </button>
              <button className="btn btn-primary" type="button" onClick={confirmBillRequest}>
                Sí, pedir la cuenta
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
