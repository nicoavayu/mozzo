export const BILL_PAYMENT_METHOD_OPTIONS = [
  {
    value: 'cash',
    label: 'Efectivo',
    customer_description: 'Te llevamos la cuenta y un mozo se acerca a cobrar en la mesa.',
    admin_description: 'Esperando cobro en efectivo.',
  },
  {
    value: 'card',
    label: 'Tarjeta',
    customer_description: 'Te llevamos la cuenta y un mozo se acerca con terminal o posnet.',
    admin_description: 'Esperando cobro con tarjeta.',
  },
  {
    value: 'mercado_pago',
    label: 'Mercado Pago',
    customer_description: 'Abrimos el checkout online para que completes el pago desde el celular.',
    admin_description: 'Checkout online iniciado o pendiente.',
  },
];

export const BILL_SPLIT_OPTIONS = [
  {
    value: 1,
    label: 'No dividir',
    customer_description: 'Una sola cuenta para la mesa.',
  },
  {
    value: 2,
    label: 'Dividir entre 2',
    customer_description: 'Preparamos la cuenta en 2 partes iguales.',
  },
  {
    value: 3,
    label: 'Dividir entre 3',
    customer_description: 'Preparamos la cuenta en 3 partes iguales.',
  },
  {
    value: 4,
    label: 'Dividir entre 4',
    customer_description: 'Preparamos la cuenta en 4 partes iguales.',
  },
];

export const BILL_PAYMENT_METHOD_LABELS = Object.fromEntries(
  BILL_PAYMENT_METHOD_OPTIONS.map((option) => [option.value, option.label])
);

export const BILL_COLLECTION_STATUS_LABELS = {
  requested: 'Cuenta solicitada',
  waiting_cash: 'Esperando cobro en efectivo',
  waiting_card: 'Esperando cobro con tarjeta',
  checkout_pending: 'Esperando pago online',
  partial_payment: 'Pago parcial registrado',
  payment_recorded: 'Pago completo registrado',
};

export function formatBillPaymentMethodLabel(value) {
  return BILL_PAYMENT_METHOD_LABELS[value] || 'Sin definir';
}

export function formatBillCollectionStatusLabel(value) {
  return BILL_COLLECTION_STATUS_LABELS[value] || 'Sin definir';
}

export function getBillPaymentOption(value) {
  return BILL_PAYMENT_METHOD_OPTIONS.find((option) => option.value === value) || null;
}

export function normalizeBillSplitChoice(value) {
  const numericValue = Number(value);

  if (!Number.isInteger(numericValue) || numericValue <= 1) {
    return 1;
  }

  if ([2, 3, 4].includes(numericValue)) {
    return numericValue;
  }

  return 1;
}

export function formatBillSplitChoiceLabel(value) {
  const normalizedValue = normalizeBillSplitChoice(value);

  if (normalizedValue <= 1) {
    return 'Cuenta sin dividir';
  }

  return `Cuenta dividida entre ${normalizedValue} ${normalizedValue === 1 ? 'persona' : 'personas'}`;
}

export function getBillSplitOption(value) {
  const normalizedValue = normalizeBillSplitChoice(value);
  return BILL_SPLIT_OPTIONS.find((option) => option.value === normalizedValue) || BILL_SPLIT_OPTIONS[0];
}
