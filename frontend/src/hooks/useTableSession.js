import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api';
import {
  isDraftLockedByActiveOrder,
  reconcileCartWithMenu,
  reconcilePersistedDraft,
  removeUnavailableItemsFromCart,
  shouldDiscardPersistedDraft,
} from '../lib/tableDraft';
import { useSocketStatus } from '../lib/useSocketStatus';

const DRAFT_STORAGE_PREFIX = 'mozzo:draft:v1:table:';

export const ACTIVE_ORDER_STATUS_LABELS = {
  pending: 'Pendiente',
  processing: 'En preparación',
  ready: 'Listo',
  delivered: 'Entregado',
};

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
    helper: 'Le avisamos al salón que querés cerrar la mesa.',
    endpoint: 'request-bill',
    success: 'Avisamos al salón que querés pedir la cuenta.',
    cancelSuccess: 'Cancelamos el pedido de cuenta para esta mesa.',
    pendingLabel: 'Cuenta solicitada',
  },
};

export function formatMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
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
  const [reloadKey, setReloadKey] = useState(0);
  const socketStatus = useSocketStatus(socket);
  const orderConfirmedTimeoutRef = useRef(null);
  const tableRequestMessageTimeoutRef = useRef(null);
  const draftHydratedRef = useRef(false);
  const numericTableId = Number(tableId);
  const isValidTableId = Number.isInteger(numericTableId) && numericTableId > 0;

  const clearOrderConfirmedTimeout = () => {
    if (orderConfirmedTimeoutRef.current) {
      window.clearTimeout(orderConfirmedTimeoutRef.current);
      orderConfirmedTimeoutRef.current = null;
    }
  };

  const clearTableRequestMessageTimeout = () => {
    if (tableRequestMessageTimeoutRef.current) {
      window.clearTimeout(tableRequestMessageTimeoutRef.current);
      tableRequestMessageTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    clearOrderConfirmedTimeout();
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
        clearOrderConfirmedTimeout();
        setOrderConfirmed(true);
        setOrderError('');
        setMenuAvailabilityFeedback('');
        setActiveOrder(order);
        setLatestOrder(order);
        setActiveOrderStatus('ready');
        setActiveOrderError('');
        setCart([]);
        writePersistedDraft(tableId, []);
        orderConfirmedTimeoutRef.current = window.setTimeout(() => {
          setOrderConfirmed(false);
          orderConfirmedTimeoutRef.current = null;
        }, 3000);
      }
    };

    const handleSocketConnect = () => {
      joinTableRoom();
      fetchMenu({ showLoader: false });
      fetchOrderSession({ showLoader: false });
      fetchTableRequests({ showLoader: false });
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

    socket.on('menu_updated', handleMenuUpdated);
    socket.on('order_confirmed', handleOrderConfirmed);
    socket.on('order_updated', handleOrderUpdated);
    socket.on('table_request_created', handleTableRequestCreated);
    socket.on('table_request_updated', handleTableRequestUpdated);
    socket.on('connect', handleSocketConnect);

    return () => {
      isMounted = false;
      clearOrderConfirmedTimeout();
      clearTableRequestMessageTimeout();
      socket.off('connect', handleSocketConnect);
      socket.off('order_confirmed', handleOrderConfirmed);
      socket.off('order_updated', handleOrderUpdated);
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
      setOrderError('La mesa ya tiene un pedido abierto. Esperá al cierre para empezar otro.');
      return;
    }

    setPlacingOrder(true);
    setOrderError('');

    try {
      const order = await apiRequest('/api/orders', {
        method: 'POST',
        body: {
          table_id: numericTableId,
          items: cart.map((item) => ({
            item_id: item.id,
            quantity: item.quantity,
            comments: item.comments,
          })),
        },
      });

      setActiveOrder(order);
      setLatestOrder(order);
      setActiveOrderStatus('ready');
      setActiveOrderError('');
      setOrderError('');
      setMenuAvailabilityFeedback('');
      clearOrderConfirmedTimeout();
      setOrderConfirmed(true);
      setCart([]);
      writePersistedDraft(tableId, []);
      orderConfirmedTimeoutRef.current = window.setTimeout(() => {
        setOrderConfirmed(false);
        orderConfirmedTimeoutRef.current = null;
      }, 3000);
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

  const submitTableRequest = async (requestType) => {
    const requestConfig = TABLE_REQUEST_CONFIG[requestType];
    if (!requestConfig) {
      return;
    }

    if (requestType === 'request_bill' && !activeOrder) {
      setTableRequestActionError('Podés pedir la cuenta después de enviar un pedido.');
      return;
    }

    setSubmittingRequestType(requestType);
    setTableRequestActionError('');
    setTableRequestFeedback('');

    try {
      const tableRequest = await apiRequest(`/api/tables/${tableId}/${requestConfig.endpoint}`, {
        method: 'POST',
      });

      setTableRequests((previous) => upsertTableRequest(previous, tableRequest));
      setTableRequestsStatus('ready');
      setTableRequestFeedback(
        tableRequest.already_pending
          ? `${requestConfig.label} ya estaba solicitado para esta mesa.`
          : requestConfig.success
      );
    } catch (error) {
      setTableRequestActionError(error.message);
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
      const tableRequest = await apiRequest(`/api/tables/${tableId}/${requestConfig.endpoint}`, {
        method: 'DELETE',
      });

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

  const reloadSession = () => {
    setReloadKey((current) => current + 1);
  };

  const clearTableRequestMessages = () => {
    clearTableRequestMessageTimeout();
    setTableRequestFeedback('');
    setTableRequestActionError('');
  };

  const cartTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const cartItemsCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const activeOrderItemsCount = (activeOrder?.items || []).reduce((sum, item) => sum + item.quantity, 0);
  const activeOrderTotal = (activeOrder?.items || []).reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const hasMenuItems = categories.some((category) => (category.items || []).length > 0);
  const pendingTableRequests = tableRequests.filter((request) => request.status === 'pending');
  const isDraftLocked = isDraftLockedByActiveOrder(activeOrder);
  const draftLockedReason = isDraftLocked
    ? 'La mesa ya tiene un pedido abierto. Esperá al cierre para empezar otro.'
    : '';
  const isWaiterRequested = pendingTableRequests.some((request) => request.type === 'call_waiter');
  const isBillRequested = Boolean(activeOrder?.bill_requested_at)
    || pendingTableRequests.some((request) => request.type === 'request_bill');
  const isBillAttended = Boolean(activeOrder?.bill_attended_at);
  const canRequestBill = Boolean(activeOrder);

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
    activeOrderTotal,
    placingOrder,
    orderError,
    orderConfirmed,
    tableRequests,
    pendingTableRequests,
    tableRequestsStatus,
    tableRequestsError,
    tableRequestFeedback,
    tableRequestActionError,
    submittingRequestType,
    socketStatus,
    hasMenuItems,
    isDraftLocked,
    draftLockedReason,
    isWaiterRequested,
    isBillRequested,
    isBillAttended,
    canRequestBill,
    addToCart,
    updateQuantity,
    updateComment,
    placeOrder,
    submitTableRequest,
    cancelTableRequest,
    reloadSession,
    clearTableRequestMessages,
  };
}
