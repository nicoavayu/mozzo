export function normalizeMercadoPagoReturnStatus(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();

  if (normalizedValue === 'approved') {
    return 'approved';
  }

  if (normalizedValue === 'pending') {
    return 'pending';
  }

  if (normalizedValue === 'failure') {
    return 'failure';
  }

  return '';
}

export function getMercadoPagoReturnFeedback(status) {
  switch (normalizeMercadoPagoReturnStatus(status)) {
    case 'approved':
      return {
        type: 'success',
        title: 'Pago aprobado',
        message: 'Mercado Pago aprobó el pago. Estamos actualizando el saldo de la mesa.',
      };
    case 'pending':
      return {
        type: 'info',
        title: 'Pago pendiente',
        message: 'Mercado Pago dejó el pago pendiente. Cuando cambie el estado, la mesa se va a actualizar sola.',
      };
    case 'failure':
      return {
        type: 'error',
        title: 'Pago no completado',
        message: 'Mercado Pago no pudo completar el pago. Podés intentarlo de nuevo o usar otro medio.',
      };
    default:
      return null;
  }
}

const FAILURE_STATUSES = new Set(['rejected', 'cancelled', 'expired', 'failed', 'refunded', 'charged_back', 'reversed']);
const FAILURE_DISPOSITIONS = new Set(['ignored', 'stale', 'mismatched']);

export function getLatestMercadoPagoAttempt(order) {
  const attempts = Array.isArray(order?.external_payment_attempts) ? order.external_payment_attempts.filter(Boolean) : [];
  return attempts.length > 0 ? attempts[attempts.length - 1] : null;
}

export function getMercadoPagoCheckoutState(order) {
  const summary = order?.external_payment_attempts_summary || {};
  const latestAttempt = getLatestMercadoPagoAttempt(order);
  const latestStatus = String(summary.latest_status || latestAttempt?.status || '').trim().toLowerCase();
  const latestSyncDisposition = String(summary.latest_sync_disposition || latestAttempt?.sync_disposition || '').trim().toLowerCase();
  const latestStatusReason = String(summary.latest_status_reason || latestAttempt?.status_reason || '').trim();
  const amountDue = Number(order?.amount_due || 0);
  const hasPendingCheckout = Number(summary.pending_count || 0) > 0
    || (latestStatus === 'pending' && latestSyncDisposition === 'pending');
  const isApproved = amountDue <= 0.009
    || (latestStatus === 'approved' && latestSyncDisposition === 'applied');
  const hasFailure = !isApproved
    && !hasPendingCheckout
    && (FAILURE_STATUSES.has(latestStatus) || FAILURE_DISPOSITIONS.has(latestSyncDisposition));

  if (isApproved) {
    return {
      latestAttempt,
      latestStatus,
      latestSyncDisposition,
      latestStatusReason,
      hasPendingCheckout: false,
      hasFailure: false,
      isApproved: true,
      actionLabel: '',
      title: 'Pago aprobado',
      message: 'Mercado Pago ya acreditó el pago. El salón todavía tiene que cerrar la mesa.',
    };
  }

  if (hasPendingCheckout) {
    return {
      latestAttempt,
      latestStatus,
      latestSyncDisposition,
      latestStatusReason,
      hasPendingCheckout: true,
      hasFailure: false,
      isApproved: false,
      actionLabel: 'Continuar pago',
      title: 'Checkout pendiente',
      message: 'Ya hay un checkout abierto para esta mesa. Si no terminaste el pago, podés continuarlo desde acá.',
    };
  }

  if (hasFailure) {
    return {
      latestAttempt,
      latestStatus,
      latestSyncDisposition,
      latestStatusReason,
      hasPendingCheckout: false,
      hasFailure: true,
      isApproved: false,
      actionLabel: 'Reintentar pago',
      title: 'Pago no confirmado',
      message: latestStatusReason || 'Mercado Pago no pudo confirmar el cobro. Podés intentarlo de nuevo.',
    };
  }

  return {
    latestAttempt,
    latestStatus,
    latestSyncDisposition,
    latestStatusReason,
    hasPendingCheckout: false,
    hasFailure: false,
    isApproved: false,
    actionLabel: 'Pagar ahora',
    title: 'Pagar la cuenta',
    message: 'Cuando quieras, podés abrir Mercado Pago y pagar el saldo total desde el celular.',
  };
}
