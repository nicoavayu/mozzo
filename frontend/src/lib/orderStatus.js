export const ACTIVE_ORDER_STATUS_LABELS = {
  pending: 'Pendiente',
  processing: 'En preparación',
  ready: 'Listo',
  delivered: 'Entregado',
};

export const CUSTOMER_ACTIVE_ORDER_STATUS = {
  pending: {
    badge: 'Recibido',
    label: 'Pedido recibido',
    helper: 'Ya entró a cocina. Te avisamos cuando empiece a prepararse.',
  },
  processing: {
    badge: 'En preparación',
    label: 'Lo estamos preparando',
    helper: 'Tu pedido ya está en cocina.',
  },
  ready: {
    badge: 'Listo',
    label: 'Tu pedido está listo',
    helper: 'Ya está listo y debería salir enseguida para tu mesa.',
  },
  delivered: {
    badge: 'En camino',
    label: 'Tu pedido va en camino',
    helper: 'Ya está saliendo para tu mesa.',
  },
};

export function getCustomerActiveOrderStatus(status) {
  return CUSTOMER_ACTIVE_ORDER_STATUS[status] || {
    badge: 'En curso',
    label: 'Pedido en curso',
    helper: 'Seguimos actualizando el estado de tu pedido.',
  };
}
