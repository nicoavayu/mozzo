export const STAFF_ROLE_OPTIONS = [
  { value: 'manager', label: 'Manager' },
  { value: 'cashier', label: 'Caja' },
  { value: 'server', label: 'Mozo' },
  { value: 'kitchen', label: 'Cocina' },
];

const PERMISSIONS_BY_ROLE = {
  owner: ['*'],
  manager: [
    'cash.open',
    'cash.close',
    'payments.create',
    'payments.reverse',
    'orders.close',
    'bill_splits.manage',
    'menu.manage',
    'requests.resolve_call_waiter',
    'requests.resolve_bill',
    'suborders.process',
    'suborders.ready',
    'suborders.deliver',
    'suborders.cancel',
  ],
  cashier: [
    'cash.open',
    'cash.close',
    'payments.create',
    'payments.reverse',
    'orders.close',
    'bill_splits.manage',
    'requests.resolve_bill',
  ],
  server: [
    'requests.resolve_call_waiter',
    'suborders.deliver',
  ],
  kitchen: [
    'suborders.process',
    'suborders.ready',
  ],
};

const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Caja',
  server: 'Mozo',
  kitchen: 'Cocina',
};

export function getRoleLabel(role) {
  return ROLE_LABELS[role] || role || 'Staff';
}

export function hasAdminPermission(actor, permission) {
  if (!actor) {
    return false;
  }

  if (actor.role === 'owner') {
    return true;
  }

  const permissions = Array.isArray(actor.permissions) ? actor.permissions : (PERMISSIONS_BY_ROLE[actor.role] || []);
  return permissions.includes(permission);
}

export function canResolveTableRequest(actor, requestType) {
  if (requestType === 'call_waiter') {
    return hasAdminPermission(actor, 'requests.resolve_call_waiter');
  }

  if (requestType === 'request_bill') {
    return hasAdminPermission(actor, 'requests.resolve_bill');
  }

  return false;
}

export function canUpdateSuborderStatus(actor, nextStatus) {
  if (nextStatus === 'processing') {
    return hasAdminPermission(actor, 'suborders.process');
  }

  if (nextStatus === 'ready') {
    return hasAdminPermission(actor, 'suborders.ready');
  }

  if (nextStatus === 'delivered') {
    return hasAdminPermission(actor, 'suborders.deliver');
  }

  if (nextStatus === 'cancelled') {
    return hasAdminPermission(actor, 'suborders.cancel');
  }

  return false;
}

export function getAdminActorBadge(actor) {
  if (!actor) {
    return 'Sin sesión';
  }

  return actor.auth_type === 'owner' ? 'Owner bootstrap' : 'Staff PIN';
}

export function buildStaffCreatePayload(form) {
  return {
    name: String(form?.name || '').trim(),
    login_code: String(form?.login_code || '').trim().toUpperCase(),
    role: String(form?.role || '').trim().toLowerCase(),
    pin: String(form?.pin || '').trim(),
  };
}

export function validateStaffCreateForm(form) {
  const payload = buildStaffCreatePayload(form);

  if (!payload.name) {
    return 'El nombre es obligatorio.';
  }

  if (!/^[A-Z0-9_-]{3,20}$/.test(payload.login_code)) {
    return 'El código debe tener entre 3 y 20 caracteres y usar solo letras, números, guion o guion bajo.';
  }

  if (!STAFF_ROLE_OPTIONS.some((option) => option.value === payload.role)) {
    return 'Elegí un rol válido.';
  }

  if (!/^\d{4,8}$/.test(payload.pin)) {
    return 'El PIN debe tener entre 4 y 8 dígitos.';
  }

  return '';
}
