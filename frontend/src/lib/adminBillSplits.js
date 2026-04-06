export const EQUAL_SPLIT_COUNTS = [2, 3, 4];

export function getBillSplitSummary(order) {
  return order?.bill_splits_summary || {
    mode: null,
    has_split_bill: false,
    can_configure: false,
    can_reconfigure: false,
    can_clear: false,
    groups: [],
    payments: [],
    unallocated_summary: {
      payments_total_unallocated: 0,
    },
  };
}

export function buildBillSplitEqualPayload(count) {
  return { count: Number(count) };
}

export function buildBillSplitAllocationPayload(splitId) {
  if (splitId == null || splitId === '') {
    return { split_id: null };
  }

  return { split_id: Number(splitId) };
}

export function getBillSplitPaymentAllocation(summary, paymentId) {
  return (summary?.payments || []).find((payment) => payment.id === paymentId) || null;
}

export function getBillSplitGroupOptions(summary) {
  return [
    { value: '', label: 'Sin asignar' },
    ...((summary?.groups || []).map((group) => ({
      value: String(group.id),
      label: group.label,
    }))),
  ];
}
