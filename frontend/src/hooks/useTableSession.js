import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api';
import { formatBillPaymentMethodLabel } from '../lib/billFlow';
import { getMercadoPagoReturnFeedback, normalizeMercadoPagoReturnStatus } from '../lib/mercadoPago';
import { getCustomerActiveOrderStatus } from '../lib/orderStatus';
export { ACTIVE_ORDER_STATUS_LABELS } from '../lib/orderStatus';
import { summarizeActiveOrderSession } from '../lib/suborders';
import {
  isDraftLockedByActiveOrder,
  reconcileCartWithMenu,
  reconcilePersistedDraft,
  removeUnavailableItemsFromCart,
  shouldDiscardPersistedDraft,
} from '../lib/tableDraft';
import { useSocketStatus } from '../lib/useSocketStatus';

const DRAFT_STORAGE_PREFIX = 'mozzo:draft:v1:table:';

export const TABLE_REQUEST_CONFIG = {
  call_waiter: {
    label: 'Llamar al mozo',
    helper: 'Avisamos al salón para que pase por tu mesa.',
    endpoint: 'call-waiter',
    success: 'Avisamos al salón que necesitás asistencia en la mesa.',
    cancelSuccess: 'Cancelamos el aviso al salón para esta mesa.',
    pendingLabel: 'Mozo en camino',
  },
  request_bill: {
    label: 'Pedir la cuenta',
    helper: 'Elegí cómo querés pagar y adaptamos el flujo de cobro.',
    endpoint: 'request-bill',
    success: 'Actualizamos cómo querés pagar la mesa.',
    cancelSuccess: 'Cancelamos el pedido de cuenta para esta mesa.',
    pendingLabel: 'Cuenta solicitada',
  },
};

export function formatMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function buildOrderStatusFeedback(status) {
  switch (status) {
    case 'processing':
      return {
        title: 'Estamos preparando tu pedido',
        message: 'La cocina ya está trabajando en tu orden.',
      };
    case 'ready':
      return {
        title: 'Tu pedido está listo',
        message: 'Ya sale para tu mesa.',
      };
    case 'delivered':
      return {
        title: 'Pedido en camino',
        message: 'Tu pedido ya va rumbo a la mesa.',
      };
    default:
      return null;
  }
}

function buildUnavailableItemsFeedback(items = []) {
  const uniqueItems = [...new Set((items || []).filter(Boolean))];

  if (uniqueItems.length === 0) {
    return '';
  }

  if (uniqueItems.length === 1) {
    return `"${uniqueItems[0]}" ya no está disponible y lo quitamos de tu pedido.`;
  }

  if (uniqueItems.length <= 3) {
    return `${uniqueItems.join(', ')} ya no están disponibles y los quitamos de tu pedido.`;
  }

  return `Quitamos ${uniqueItems.length} productos porque ya no están disponibles.`;
}

function buildBillRequestSuccessMessage(method, { online = false, alreadyPending = false } = {}) {
  if (online || method === 'mercado_pago') {
    return alreadyPending
      ? 'Mercado Pago ya estaba seleccionado para esta mesa. Podés continuar el checkout online.'
      : 'Abrimos Mercado Pago para que puedas pagar desde el celular.';
  }

  const methodLabel = formatBillPaymentMethodLabel(method).toLowerCase();

  return alreadyPending
    ? `Actualizamos la cuenta para cobrar ${methodLabel} en la mesa.`
    : `Avisamos al salón que querés pagar ${methodLabel}.`;
}

function upsertTableRequest(list, nextRequest) {
  const filtered = list.filter((request) => request.id !== nextRequest.id);

  return [nextRequest, ...filtered].sort(
    (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  );
}

function getDraftStorageKey(tableId) {
  return `${DRAFT_STORAGE_PREFIX}${tableId}`;
}

function readPersistedDraft(tableId) {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(getDraftStorageKey(tableId));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.items) ? parsed : null;
  } catch {
    return null;
  }
}

function writePersistedDraft(tableId, cart) {
  if (typeof window === 'undefined') {
    return;
  }

  const storageKey = getDraftStorageKey(tableId);

  if (!Array.isArray(cart) || cart.length === 0) {
    window.localStorage.removeItem(storageKey);
    return;
  }

  window.localStorage.setItem(
    storageKey,
    JSON.stringify({
      items: cart.map((item) => ({
        item_id: item.id,
        quantity: item.quantity,
        comments: item.comments || '',
      })),
      updated_at: new Date().toISOString(),
    })
  );
}

export default function useTableSession(tableId, socket) {
  const [categories, setCategories] = useState([]);
  const [menuStatus, setMenuStatus] = useState('loading');
  const [menuError, setMenuError] = useState('');
  const [menuAvailabilityFeedback, setMenuAvailabilityFeedback] = useState('');
  const [cart, setCart] = useState([]);
  const [activeOrder, setActiveOrder] = useState(null);
  const [latestOrder, setLatestOrder] = useState(null);
  const [activeOrderStatus, setActiveOrderStatus] = useState('loading');
  const [activeOrderError, setActiveOrderError] = useState('');
  const [placingOrder, setPlacingOrder] = useState(false);
  const [orderError, setOrderError] = useState('');
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [tableRequests, setTableRequests] = useState([]);
  const [tableRequestsStatus, setTableRequestsStatus] = useState('loading');
  const [tableRequestsError, setTableRequestsError] = useState('');
  const [tableRequestFeedback, setTableRequestFeedback] = useState('');
  const [tableRequestActionError, setTableRequestActionError] = useState('');
  const [submittingRequestType, setSubmittingRequestType] = useState('');
  const [mercadoPagoEnabled, setMercadoPagoEnabled] = useState(false);
  const [startingMercadoPagoCheckout, setStartingMercadoPagoCheckout] = useState(false);
  const [mercadoPagoActionError, setMercadoPagoActionError] = useState('');
  const [mercadoPagoFeedback, setMercadoPagoFeedback] = useState(null);
  const [orderStatusFeedback, setOrderStatusFeedback] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const socketStatus = useSocketStatus(socket);
  const tableRequestMessageTimeoutRef = useRef(null);
  const orderStatusFeedbackTimeoutRef = useRef(null);
  const draftHydratedRef = useRef(false);
  const lastKnownOrderStatusRef = useRef('');
  const numericTableId = Number(tableId);
  const isValidTableId = Number.isInteger(numericTableId) && numericTableId > 0;

  const clearOrderConfirmed = () => {
    setOrderConfirmed(false);
  };

  const clearTableRequestMessageTimeout = () => {
    if (tableRequestMessageTimeoutRef.current) {
      window.clearTimeout(tableRequestMessageTimeoutRef.current);
      tableRequestMessageTimeoutRef.current = null;
    }
  };

  const clearOrderStatusFeedbackTimeout = () => {
    if (orderStatusFeedbackTimeoutRef.current) {
      window.clearTimeout(orderStatusFeedbackTimeoutRef.current);
      orderStatusFeedbackTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    clearTableRequestMessageTimeout();
    draftHydratedRef.current = false;
    setCategories([]);
    setMenuStatus('loading');
    setMenuError('');
    setMenuAvailabilityFeedback('');
    setCart([]);
    setLatestOrder(null);
    setActiveOrderStatus('loading');
    setActiveOrder(null);
    setActiveOrderError('');
    setPlacingOrder(false);
    setOrderError('');
    setOrderConfirmed(false);
    setTableRequestsStatus('loading');
    setTableRequests([]);
    setTableRequestsError('');
    setTableRequestFeedback('');
    setTableRequestActionError('');
    setSubmittingRequestType('');
    setMercadoPagoEnabled(false);
    setStartingMercadoPagoCheckout(false);
    setMercadoPagoActionError('');
    setMercadoPagoFeedback(null);
    setOrderStatusFeedback(null);
    lastKnownOrderStatusRef.current = '';
    clearOrderStatusFeedbackTimeout();
  }, [tableId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const currentUrl = new URL(window.location.href);
    const returnStatus = normalizeMercadoPagoReturnStatus(currentUrl.searchParams.get('mp_status'));

    if (!returnStatus) {
      return;
    }

    setMercadoPagoFeedback(getMercadoPagoReturnFeedback(returnStatus));
    setMercadoPagoActionError('');
    currentUrl.searchParams.delete('mp_status');
    window.history.replaceState({}, '', currentUrl.toString());
  }, [tableId]);

  useEffect(() => {
    if (!isValidTableId || draftHydratedRef.current) {
      return;
    }

    if ((menuStatus !== 'ready' && menuStatus !== 'empty') || activeOrderStatus === 'loading') {
      return;
    }

    draftHydratedRef.current = true;
    const persistedDraft = readPersistedDraft(tableId);

    if (!persistedDraft) {
      setCart([]);
      return;
    }

    if (shouldDiscardPersistedDraft({ persistedDraft, activeOrder, latestOrder })) {
      setCart([]);
      writePersistedDraft(tableId, []);
      return;
    }

    const { cart: hydratedCart, unavailableItems } = reconcilePersistedDraft(categories, persistedDraft);
    setCart(hydratedCart);
    writePersistedDraft(tableId, hydratedCart);

    if (unavailableItems.length > 0) {
      setMenuAvailabilityFeedback(buildUnavailableItemsFeedback(unavailableItems));
    }
  }, [tableId, isValidTableId, categories, menuStatus, activeOrderStatus, activeOrder, latestOrder]);

  useEffect(() => {
    if (!draftHydratedRef.current || !isValidTableId) {
      return;
    }

    writePersistedDraft(tableId, cart);
  }, [tableId, cart, isValidTableId]);

  useEffect(() => {
    if (!draftHydratedRef.current || menuStatus !== 'ready') {
      return;
    }

    setCart((previousCart) => {
      if (previousCart.length === 0) {
        return previousCart;
      }

      const {
        cart: reconciledCart,
        unavailableItems,
      } = reconcileCartWithMenu(categories, previousCart);

      const previousSignature = JSON.stringify(previousCart.map((item) => [item.id, item.quantity, item.comments || '']));
      const nextSignature = JSON.stringify(reconciledCart.map((item) => [item.id, item.quantity, item.comments || '']));

      if (previousSignature === nextSignature) {
        return previousCart;
      }

      if (unavailableItems.length > 0) {
        setMenuAvailabilityFeedback(buildUnavailableItemsFeedback(unavailableItems));
      }

      writePersistedDraft(tableId, reconciledCart);
      return reconciledCart;
    });
  }, [categories, menuStatus, tableId]);

  useEffect(() => {
    if (!isValidTableId || !activeOrder) {
      return;
    }

    if (!isDraftLockedByActiveOrder(activeOrder)) {
      return;
    }

    setCart((previousCart) => (previousCart.length === 0 ? previousCart : []));
    writePersistedDraft(tableId, []);
    setMenuAvailabilityFeedback('');
  }, [tableId, isValidTableId, activeOrder]);

  useEffect(() => {
    clearTableRequestMessageTimeout();

    if (!tableRequestFeedback && !tableRequestActionError) {
      return undefined;
    }

    tableRequestMessageTimeoutRef.current = window.setTimeout(() => {
      setTableRequestFeedback('');
      setTableRequestActionError('');
      tableRequestMessageTimeoutRef.current = null;
    }, 3600);

    return clearTableRequestMessageTimeout;
  }, [tableRequestFeedback, tableRequestActionError]);

  useEffect(() => {
    clearOrderStatusFeedbackTimeout();

    if (!orderStatusFeedback) {
      return undefined;
    }

    orderStatusFeedbackTimeoutRef.current = window.setTimeout(() => {
      setOrderStatusFeedback(null);
      orderStatusFeedbackTimeoutRef.current = null;
    }, 3600);

    return clearOrderStatusFeedbackTimeout;
  }, [orderStatusFeedback]);

  useEffect(() => {
    const nextSignature = activeOrder?.id ? `${activeOrder.id}:${activeOrder.status}` : '';

    if (!nextSignature) {
      lastKnownOrderStatusRef.current = '';
      return;
    }

    if (!lastKnownOrderStatusRef.current) {
      lastKnownOrderStatusRef.current = nextSignature;
      return;
    }

    if (lastKnownOrderStatusRef.current === nextSignature) {
      return;
    }

    const [previousOrderId, previousStatus] = lastKnownOrderStatusRef.current.split(':');
    lastKnownOrderStatusRef.current = nextSignature;

    if (String(previousOrderId) !== String(activeOrder.id) || previousStatus === activeOrder.status) {
      return;
    }

    const nextFeedback = buildOrderStatusFeedback(activeOrder.status);

    if (nextFeedback) {
      setOrderStatusFeedback(nextFeedback);
    }
  }, [activeOrder]);

  useEffect(() => {
    let isMounted = true;

    const fetchMenu = async ({ showLoader = true } = {}) => {
      if (showLoader) {
        setMenuStatus('loading');
      }
      setMenuError('');

      try {
        const data = await apiRequest('/api/menu');

        if (!isMounted) {
          return;
        }

        const nextCategories = Array.isArray(data) ? data : [];
        const nextHasMenuItems = nextCategories.some((category) => (category.items || []).length > 0);
        setCategories(nextCategories);
        setMenuStatus(nextHasMenuItems ? 'ready' : 'empty');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setMenuStatus('error');
        setMenuError(error.message);
      }
    };

    const fetchOrderSession = async ({ showLoader = true } = {}) => {
      if (showLoader) {
        setActiveOrderStatus('loading');
      }
      setActiveOrderError('');

      try {
        const data = await apiRequest(`/api/tables/${tableId}/orders/session`);

        if (!isMounted) {
          return;
        }

        const nextActiveOrder = data?.active_order || null;
        const nextLatestOrder = data?.latest_order || null;
        setActiveOrder(nextActiveOrder);
        setLatestOrder(nextLatestOrder);
        setActiveOrderStatus(nextActiveOrder ? 'ready' : 'empty');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setActiveOrderStatus('error');
        setActiveOrderError(error.message);
      }
    };

    const fetchTableRequests = async ({ showLoader = true } = {}) => {
      if (showLoader) {
        setTableRequestsStatus('loading');
      }
      setTableRequestsError('');

      try {
        const data = await apiRequest(`/api/tables/${tableId}/requests/active`);

        if (!isMounted) {
          return;
        }

        const nextRequests = Array.isArray(data) ? data : [];
        setTableRequests(nextRequests);
        setTableRequestsStatus(nextRequests.length > 0 ? 'ready' : 'empty');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setTableRequestsStatus('error');
        setTableRequestsError(error.message);
      }
    };

    const fetchMercadoPagoStatus = async () => {
      try {
        const data = await apiRequest('/api/payments/mercado-pago/status');

        if (!isMounted) {
          return;
        }

        setMercadoPagoEnabled(Boolean(data?.enabled));
      } catch {
        if (!isMounted) {
          return;
        }

        setMercadoPagoEnabled(false);
      }
    };

    const joinTableRoom = () => {
      socket.emit('join_table', { table_id: numericTableId }, (response) => {
        if (!isMounted || response?.success !== false) {
          return;
        }

        setActiveOrderStatus('error');
        setActiveOrderError(response.error || 'No pudimos vincular esta mesa al canal realtime.');
      });
    };

    const handleOrderConfirmed = (order) => {
      if (String(order.table_id) === String(tableId)) {
        setOrderConfirmed(true);
        setOrderError('');
        setMenuAvailabilityFeedback('');
        setActiveOrder(order);
        setLatestOrder(order);
        setActiveOrderStatus('ready');
        setActiveOrderError('');
        setCart([]);
        writePersistedDraft(tableId, []);
      }
    };

    const handleSocketConnect = () => {
      joinTableRoom();
      fetchMenu({ showLoader: false });
      fetchOrderSession({ showLoader: false });
      fetchTableRequests({ showLoader: false });
      fetchMercadoPagoStatus();
    };

    const handleMenuUpdated = () => {
      fetchMenu({ showLoader: false });
    };

    const handleOrderUpdated = (order) => {
      if (String(order?.table_id) !== String(tableId)) {
        return;
      }

      if (order?.closed_at) {
        setActiveOrder(null);
        setLatestOrder(order);
        setActiveOrderStatus('empty');
        setActiveOrderError('');
        setCart([]);
        writePersistedDraft(tableId, []);
        setMenuAvailabilityFeedback('');
        return;
      }

      setActiveOrder(order);
      setLatestOrder(order);
      setActiveOrderStatus('ready');
      setActiveOrderError('');
    };

    const handleSuborderCreated = (payload) => {
      const nextSuborder = payload?.suborder || null;
      const nextOrder = payload?.order || null;

      if (String(nextSuborder?.table_id || nextOrder?.table_id) !== String(tableId)) {
        return;
      }

      if (nextOrder) {
        setActiveOrder(nextOrder);
        setLatestOrder(nextOrder);
        setActiveOrderStatus(nextOrder.closed_at ? 'empty' : 'ready');
        setActiveOrderError('');
      }

      setOrderConfirmed(true);
    };

    const handleSuborderUpdated = (payload) => {
      const nextSuborder = payload?.suborder || null;
      const nextOrder = payload?.order || null;

      if (String(nextSuborder?.table_id || nextOrder?.table_id) !== String(tableId)) {
        return;
      }

      if (nextOrder) {
        setActiveOrder(nextOrder);
        setLatestOrder(nextOrder);
        setActiveOrderStatus(nextOrder.closed_at ? 'empty' : 'ready');
        setActiveOrderError('');
      }
    };

    const handleTableRequestCreated = (request) => {
      if (String(request.table_id) !== String(tableId)) {
        return;
      }

      setTableRequests((previous) => upsertTableRequest(previous, request));
      setTableRequestsStatus('ready');
      setTableRequestsError('');
    };

    const handleTableRequestUpdated = (request) => {
      if (String(request.table_id) !== String(tableId)) {
        return;
      }

      setTableRequests((previous) => {
        const nextRequests = upsertTableRequest(previous, request);
        return nextRequests.filter((entry) => entry.status === 'pending');
      });
      setTableRequestsStatus('ready');
      setTableRequestsError('');
    };

    if (!isValidTableId) {
      setMenuStatus('error');
      setMenuError('La mesa solicitada no es válida.');
      setActiveOrderStatus('error');
      setActiveOrderError('La mesa solicitada no es válida.');
      setTableRequestsStatus('error');
      setTableRequestsError('La mesa solicitada no es válida.');

      return () => {
        isMounted = false;
      };
    }

    joinTableRoom();
    fetchMenu();
    fetchOrderSession();
    fetchTableRequests();
    fetchMercadoPagoStatus();

    socket.on('menu_updated', handleMenuUpdated);
    socket.on('order_confirmed', handleOrderConfirmed);
    socket.on('order_updated', handleOrderUpdated);
    socket.on('suborder_created', handleSuborderCreated);
    socket.on('suborder_updated', handleSuborderUpdated);
    socket.on('table_request_created', handleTableRequestCreated);
    socket.on('table_request_updated', handleTableRequestUpdated);
    socket.on('connect', handleSocketConnect);

    return () => {
      isMounted = false;
      clearTableRequestMessageTimeout();
      clearOrderStatusFeedbackTimeout();
      socket.off('connect', handleSocketConnect);
      socket.off('order_confirmed', handleOrderConfirmed);
      socket.off('order_updated', handleOrderUpdated);
      socket.off('suborder_created', handleSuborderCreated);
      socket.off('suborder_updated', handleSuborderUpdated);
      socket.off('table_request_created', handleTableRequestCreated);
      socket.off('table_request_updated', handleTableRequestUpdated);
      socket.off('menu_updated', handleMenuUpdated);
    };
  }, [reloadKey, tableId, socket, numericTableId, isValidTableId]);

  const addToCart = (item) => {
    if (isDraftLockedByActiveOrder(activeOrder)) {
      return;
    }

    if (item?.is_available === false || Number(item?.is_available) === 0) {
      setMenuAvailabilityFeedback(`"${item.name}" no está disponible en este momento.`);
      return;
    }

    setMenuAvailabilityFeedback('');
    setCart((previousItems) => {
      const existingItem = previousItems.find((cartItem) => cartItem.id === item.id);

      if (existingItem) {
        return previousItems.map((cartItem) => (
          cartItem.id === item.id
            ? { ...cartItem, quantity: cartItem.quantity + 1 }
            : cartItem
        ));
      }

      return [...previousItems, { ...item, quantity: 1, comments: '' }];
    });
  };

  const updateQuantity = (itemId, delta) => {
    if (isDraftLockedByActiveOrder(activeOrder)) {
      return;
    }

    setMenuAvailabilityFeedback('');
    setCart((previousItems) => previousItems
      .map((item) => {
        if (item.id === itemId) {
          const nextQuantity = item.quantity + delta;
          return { ...item, quantity: Math.max(0, nextQuantity) };
        }

        return item;
      })
      .filter((item) => item.quantity > 0));
  };

  const updateComment = (itemId, comment) => {
    if (isDraftLockedByActiveOrder(activeOrder)) {
      return;
    }

    setMenuAvailabilityFeedback('');
    setCart((previousItems) => previousItems.map((item) => (
      item.id === itemId ? { ...item, comments: comment } : item
    )));
  };

  const placeOrder = async () => {
    if (cart.length === 0 || !isValidTableId) {
      return;
    }

    if (isDraftLockedByActiveOrder(activeOrder)) {
      setOrderError('La mesa ya pidió la cuenta. Ya no se pueden agregar más pedidos.');
      return;
    }

    setPlacingOrder(true);
    setOrderError('');

    try {
      const endpoint = activeOrder ? `/api/tables/${tableId}/suborders` : '/api/orders';
      const response = await apiRequest(endpoint, {
        method: 'POST',
        body: {
          ...(activeOrder ? {} : { table_id: numericTableId }),
          items: cart.map((item) => ({
            item_id: item.id,
            quantity: item.quantity,
            comments: item.comments,
          })),
        },
      });

      const order = activeOrder ? (response?.order || null) : response;
      setActiveOrder(order);
      setLatestOrder(order);
      setActiveOrderStatus('ready');
      setActiveOrderError('');
      setOrderError('');
      setMenuAvailabilityFeedback('');
      setOrderConfirmed(true);
      setCart([]);
      writePersistedDraft(tableId, []);
    } catch (error) {
      if (error?.details?.code === 'ITEM_UNAVAILABLE') {
        const { cart: nextCart, unavailableItems } = removeUnavailableItemsFromCart(
          cart,
          error?.details?.unavailable_items || []
        );

        setCart(nextCart);
        writePersistedDraft(tableId, nextCart);
        setMenuAvailabilityFeedback(buildUnavailableItemsFeedback(unavailableItems));
        setReloadKey((current) => current + 1);
      }

      setOrderError(error.message);
    } finally {
      setPlacingOrder(false);
    }
  };

  const submitTableRequest = async (requestType, payload = {}) => {
    const requestConfig = TABLE_REQUEST_CONFIG[requestType];
    if (!requestConfig) {
      return null;
    }

    if (requestType === 'request_bill' && !activeOrder) {
      setTableRequestActionError('Podés pedir la cuenta después de enviar un pedido.');
      return null;
    }

    setSubmittingRequestType(requestType);
    setTableRequestActionError('');
    setTableRequestFeedback('');

    try {
      const response = await apiRequest(`/api/tables/${tableId}/${requestConfig.endpoint}`, {
        method: 'POST',
        body: requestType === 'request_bill'
          ? { preferred_payment_method: payload?.preferred_payment_method }
          : undefined,
      });

      if (requestType === 'request_bill') {
        const nextOrder = response?.order || null;
        const nextTableRequest = response?.table_request || null;
        const resolvedRequests = Array.isArray(response?.resolved_requests) ? response.resolved_requests : [];
        const preferredMethod = response?.preferred_payment_method || payload?.preferred_payment_method || 'cash';

        if (nextOrder) {
          setActiveOrder(nextOrder);
          setLatestOrder(nextOrder);
          setActiveOrderStatus(nextOrder.closed_at ? 'empty' : 'ready');
          setActiveOrderError('');
        }

        setTableRequests((previous) => {
          const resolvedIds = new Set(resolvedRequests.map((request) => request?.id).filter(Boolean));
          let nextRequests = previous.filter((entry) => !resolvedIds.has(entry.id));

          if (nextTableRequest) {
            if (nextTableRequest.status === 'pending') {
              nextRequests = upsertTableRequest(nextRequests, nextTableRequest);
            } else {
              nextRequests = nextRequests.filter((entry) => entry.id !== nextTableRequest.id);
            }
          } else if (preferredMethod === 'mercado_pago') {
            nextRequests = nextRequests.filter((entry) => !(entry.type === 'request_bill' && entry.status === 'pending'));
          }

          setTableRequestsStatus(nextRequests.length > 0 ? 'ready' : 'empty');
          return nextRequests;
        });
        setTableRequestsError('');
        setTableRequestFeedback(
          buildBillRequestSuccessMessage(preferredMethod, {
            online: Boolean(response?.should_start_online_checkout),
            alreadyPending: Boolean(nextTableRequest?.already_pending),
          })
        );
        return response;
      }

      setTableRequests((previous) => upsertTableRequest(previous, response));
      setTableRequestsStatus('ready');
      setTableRequestFeedback(
        response.already_pending
          ? `${requestConfig.label} ya estaba solicitado para esta mesa.`
          : requestConfig.success
      );
      return response;
    } catch (error) {
      setTableRequestActionError(error.message);
      return null;
    } finally {
      setSubmittingRequestType('');
    }
  };

  const cancelTableRequest = async (requestType) => {
    const requestConfig = TABLE_REQUEST_CONFIG[requestType];
    if (!requestConfig) {
      return;
    }

    setSubmittingRequestType(requestType);
    setTableRequestActionError('');
    setTableRequestFeedback('');

    try {
      const response = await apiRequest(`/api/tables/${tableId}/${requestConfig.endpoint}`, {
        method: 'DELETE',
      });

      const nextOrder = response?.order || null;
      const tableRequest = response?.table_request || response;

      if (requestType === 'request_bill' && nextOrder) {
        setActiveOrder(nextOrder);
        setLatestOrder(nextOrder);
        setActiveOrderStatus(nextOrder.closed_at ? 'empty' : 'ready');
        setActiveOrderError('');
      }

      setTableRequests((previous) => {
        const nextRequests = requestType === 'request_bill'
          ? previous.filter((entry) => !(entry.type === 'request_bill' && entry.status === 'pending'))
          : upsertTableRequest(previous, tableRequest)
            .filter((entry) => entry.status === 'pending');
        setTableRequestsStatus(nextRequests.length > 0 ? 'ready' : 'empty');
        return nextRequests;
      });
      setTableRequestsError('');
      setTableRequestFeedback(requestConfig.cancelSuccess);
    } catch (error) {
      setTableRequestActionError(error.message);
    } finally {
      setSubmittingRequestType('');
    }
  };

  const startMercadoPagoCheckout = async (options = {}) => {
    const targetOrder = options?.order || activeOrder;

    if (!targetOrder || !isValidTableId) {
      return;
    }

    setStartingMercadoPagoCheckout(true);
    setMercadoPagoActionError('');
    setMercadoPagoFeedback(null);

    try {
      const checkout = await apiRequest(`/api/tables/${tableId}/mercado-pago/checkout`, {
        method: 'POST',
      });

      if (!checkout?.checkout_url) {
        throw new Error('No pudimos iniciar Mercado Pago.');
      }

      window.location.assign(checkout.checkout_url);
    } catch (error) {
      setMercadoPagoActionError(error.message);
    } finally {
      setStartingMercadoPagoCheckout(false);
    }
  };

  const reloadSession = () => {
    setReloadKey((current) => current + 1);
  };

  const clearTableRequestMessages = () => {
    clearTableRequestMessageTimeout();
    setTableRequestFeedback('');
    setTableRequestActionError('');
  };

  const clearMercadoPagoMessages = () => {
    setMercadoPagoActionError('');
    setMercadoPagoFeedback(null);
  };

  const clearOrderStatusFeedback = () => {
    clearOrderStatusFeedbackTimeout();
    setOrderStatusFeedback(null);
  };

  const cartTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const cartItemsCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const activeOrderItemsCount = (activeOrder?.items || []).reduce((sum, item) => sum + item.quantity, 0);
  const activeOrderSessionSummary = summarizeActiveOrderSession(activeOrder);
  const activeOrderSubordersCount = activeOrderSessionSummary.subordersCount;
  const activeOrderTotal = Number(activeOrder?.total_amount || 0);
  const activeOrderAmountPaid = Number(activeOrder?.amount_paid || 0);
  const activeOrderAmountDue = Number(activeOrder?.amount_due || activeOrderTotal || 0);
  const activeOrderPaymentStatus = activeOrder?.payment_status || 'unpaid';
  const activeOrderCustomerStatus = activeOrder ? getCustomerActiveOrderStatus(activeOrder.status) : null;
  const billPaymentMethodPreference = activeOrder?.bill_payment_method_preference || null;
  const billCollectionStatus = activeOrder?.bill_collection_status || null;
  const hasMenuItems = categories.some((category) => (category.items || []).length > 0);
  const pendingTableRequests = tableRequests.filter((request) => request.status === 'pending');
  const isDraftLocked = isDraftLockedByActiveOrder(activeOrder);
  const draftLockedReason = isDraftLocked
    ? 'La mesa ya pidió la cuenta. Ya no se pueden agregar más pedidos.'
    : '';
  const isWaiterRequested = pendingTableRequests.some((request) => request.type === 'call_waiter');
  const isBillRequested = Boolean(activeOrder?.bill_requested_at)
    || pendingTableRequests.some((request) => request.type === 'request_bill');
  const isBillAttended = Boolean(activeOrder?.bill_attended_at);
  const canRequestBill = Boolean(
    activeOrder
    && activeOrder.status === 'delivered'
    && !activeOrder.closed_at
    && activeOrderAmountDue > 0
  );
  const canManageBillFlow = Boolean(
    activeOrder
    && !activeOrder.closed_at
    && activeOrderAmountDue > 0
    && (activeOrder.status === 'delivered' || isBillRequested)
  );
  const canPayWithMercadoPago = Boolean(
    mercadoPagoEnabled
    && activeOrder
    && activeOrder.bill_attended_at
    && !activeOrder.closed_at
    && activeOrderAmountDue > 0
    && billPaymentMethodPreference === 'mercado_pago'
  );

  return {
    tableId,
    numericTableId,
    isValidTableId,
    categories,
    menuStatus,
    menuError,
    menuAvailabilityFeedback,
    cart,
    cartTotal,
    cartItemsCount,
    activeOrder,
    latestOrder,
    activeOrderStatus,
    activeOrderError,
    activeOrderItemsCount,
    activeOrderSubordersCount,
    activeOrderTotal,
    activeOrderAmountPaid,
    activeOrderAmountDue,
    activeOrderPaymentStatus,
    activeOrderCustomerStatus,
    billPaymentMethodPreference,
    billCollectionStatus,
    placingOrder,
    orderError,
    orderConfirmed,
    clearOrderConfirmed,
    tableRequests,
    pendingTableRequests,
    tableRequestsStatus,
    tableRequestsError,
    tableRequestFeedback,
    tableRequestActionError,
    submittingRequestType,
    mercadoPagoEnabled,
    startingMercadoPagoCheckout,
    mercadoPagoActionError,
    mercadoPagoFeedback,
    orderStatusFeedback,
    socketStatus,
    hasMenuItems,
    isDraftLocked,
    draftLockedReason,
    isWaiterRequested,
    isBillRequested,
    isBillAttended,
    canRequestBill,
    canManageBillFlow,
    canPayWithMercadoPago,
    addToCart,
    updateQuantity,
    updateComment,
    placeOrder,
    submitTableRequest,
    cancelTableRequest,
    startMercadoPagoCheckout,
    reloadSession,
    clearTableRequestMessages,
    clearMercadoPagoMessages,
    clearOrderStatusFeedback,
  };
}
