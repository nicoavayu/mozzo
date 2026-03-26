function isItemAvailable(item) {
  return !(item && (item.is_available === false || Number(item.is_available) === 0));
}

function buildMenuItemIndex(categories) {
  const itemIndex = new Map();

  categories.forEach((category) => {
    (category.items || []).forEach((item) => {
      itemIndex.set(Number(item.id), item);
    });
  });

  return itemIndex;
}

function dedupeNames(names = []) {
  return [...new Set(names.filter(Boolean))];
}

export function reconcilePersistedDraft(categories, persistedDraft) {
  const itemIndex = buildMenuItemIndex(categories);
  const unavailableItems = [];

  const cart = (persistedDraft?.items || []).reduce((nextCart, draftItem) => {
    const item = itemIndex.get(Number(draftItem?.item_id));
    const quantity = Number(draftItem?.quantity);

    if (!item || !Number.isInteger(quantity) || quantity <= 0) {
      return nextCart;
    }

    if (!isItemAvailable(item)) {
      unavailableItems.push(item.name);
      return nextCart;
    }

    nextCart.push({
      ...item,
      quantity,
      comments: typeof draftItem?.comments === 'string' ? draftItem.comments : '',
    });

    return nextCart;
  }, []);

  return {
    cart,
    unavailableItems: dedupeNames(unavailableItems),
  };
}

export function buildCartFromPersistedDraft(categories, persistedDraft) {
  return reconcilePersistedDraft(categories, persistedDraft).cart;
}

export function reconcileCartWithMenu(categories, cart) {
  return reconcilePersistedDraft(categories, {
    items: (cart || []).map((item) => ({
      item_id: item.id,
      quantity: item.quantity,
      comments: item.comments || '',
    })),
  });
}

export function removeUnavailableItemsFromCart(cart = [], unavailableItems = []) {
  const unavailableIds = new Set(
    unavailableItems
      .map((item) => Number(typeof item === 'object' ? item?.item_id : item))
      .filter((itemId) => Number.isInteger(itemId) && itemId > 0)
  );

  const removedItems = [];
  const nextCart = (cart || []).filter((item) => {
    if (!unavailableIds.has(Number(item.id))) {
      return true;
    }

    removedItems.push(item.name);
    return false;
  });

  return {
    cart: nextCart,
    unavailableItems: dedupeNames(removedItems),
  };
}

export function shouldDiscardPersistedDraft({ persistedDraft, activeOrder, latestOrder }) {
  if (!persistedDraft) {
    return false;
  }

  if (activeOrder) {
    return true;
  }

  if (!latestOrder?.closed_at) {
    return false;
  }

  const draftUpdatedAt = Date.parse(persistedDraft.updated_at || '');
  const latestClosedAt = Date.parse(latestOrder.closed_at || '');

  if (Number.isNaN(draftUpdatedAt) || Number.isNaN(latestClosedAt)) {
    return false;
  }

  return draftUpdatedAt <= latestClosedAt;
}

export function isDraftLockedByActiveOrder(activeOrder) {
  return Boolean(activeOrder);
}
