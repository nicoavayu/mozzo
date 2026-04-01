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
