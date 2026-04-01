import { getCustomerActiveOrderStatus } from './orderStatus.js';

export function getSuborderLabel(sequenceNumber) {
  return `Envio ${Number(sequenceNumber || 0) || 1}`;
}

export function summarizeActiveOrderSession(order) {
  const suborders = Array.isArray(order?.suborders) ? order.suborders : [];
  const activeSuborders = suborders.filter((suborder) => suborder.status !== 'cancelled');
  const itemsCount = activeSuborders.reduce(
    (sum, suborder) => sum + (suborder.items || []).reduce((itemsSum, item) => itemsSum + Number(item.quantity || 0), 0),
    0
  );

  return {
    subordersCount: activeSuborders.length,
    itemsCount,
    latestSuborder: activeSuborders[activeSuborders.length - 1] || null,
  };
}

export function getSuborderStatusDescriptor(suborder) {
  if (!suborder) {
    return null;
  }

  return getCustomerActiveOrderStatus(suborder.status);
}

export function sortSuborders(suborders = []) {
  return [...(Array.isArray(suborders) ? suborders : [])].sort((left, right) => {
    const leftSequence = Number(left.sequence_number || 0);
    const rightSequence = Number(right.sequence_number || 0);
    return leftSequence - rightSequence || Number(left.id || 0) - Number(right.id || 0);
  });
}
