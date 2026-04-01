import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import { formatMoney } from '../../hooks/useTableSession';
import FloatingOrderDock from './FloatingOrderDock';
import OrderConfirmedModal from './OrderConfirmedModal';

function categoryDomId(categoryName, index) {
  return `category-${index}-${String(categoryName || '')
    .toLowerCase()
    .replace(/[^\w]+/g, '-')}`;
}

function getCartQuantity(cart, itemId) {
  return cart.find((item) => item.id === itemId)?.quantity || 0;
}

function wasAlreadyOrdered(activeOrder, itemId) {
  return Boolean((activeOrder?.items || []).some((item) => Number(item.item_id) === Number(itemId)));
}

export default function TableMenuPage() {
  const {
    tableId,
    categories,
    menuStatus,
    menuError,
    menuAvailabilityFeedback,
    cart,
    activeOrder,
    activeOrderItemsCount,
    isDraftLocked,
    draftLockedReason,
    addToCart,
    updateQuantity,
    reloadSession,
    orderConfirmed,
    clearOrderConfirmed,
  } = useOutletContext();

  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [activeCategoryId, setActiveCategoryId] = useState('');
  const searchShellRef = useRef(null);
  const categoryBarRef = useRef(null);
  const [stickyMetrics, setStickyMetrics] = useState({
    anchorOffset: 96,
    spyOffset: 96,
  });
  const [categoryScrollState, setCategoryScrollState] = useState({
    canScrollLeft: false,
    canScrollRight: false,
  });

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredCategories = normalizedSearch
    ? categories
      .map((category) => ({
        ...category,
        items: (category.items || []).filter((item) => {
          const searchTarget = `${item.name} ${item.description || ''}`.toLowerCase();
          return searchTarget.includes(normalizedSearch);
        }),
      }))
      .filter((category) => category.items.length > 0)
    : categories;

  const hasMenuItems = categories.some((category) => (category.items || []).length > 0);
  const hasVisibleMenuItems = filteredCategories.some((category) => (category.items || []).length > 0);

  useEffect(() => {
    const updateCategoryScrollState = () => {
      const container = categoryBarRef.current;
      if (!container) {
        setCategoryScrollState({ canScrollLeft: false, canScrollRight: false });
        return;
      }

      const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
      setCategoryScrollState({
        canScrollLeft: container.scrollLeft > 8,
        canScrollRight: container.scrollLeft < maxScrollLeft - 8,
      });
    };

    const frameId = window.requestAnimationFrame(updateCategoryScrollState);
    window.addEventListener('resize', updateCategoryScrollState);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', updateCategoryScrollState);
    };
  }, [filteredCategories, hasVisibleMenuItems, normalizedSearch]);

  useEffect(() => {
    const measureStickyMetrics = () => {
      const searchHeight = searchShellRef.current?.offsetHeight || 0;
      const anchorOffset = 8 + searchHeight + 18;
      const spyOffset = Math.max(anchorOffset, 96);

      setStickyMetrics((previous) => {
        if (
          previous.anchorOffset === anchorOffset
          && previous.spyOffset === spyOffset
        ) {
          return previous;
        }

        return { anchorOffset, spyOffset };
      });
    };

    const frameId = window.requestAnimationFrame(measureStickyMetrics);
    window.addEventListener('resize', measureStickyMetrics);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', measureStickyMetrics);
    };
  }, [hasMenuItems, hasVisibleMenuItems, normalizedSearch, filteredCategories.length]);

  useEffect(() => {
    if (!hasVisibleMenuItems) {
      return undefined;
    }

    const categoryIds = filteredCategories.map((category, index) => categoryDomId(category.name, index));

    const handleScroll = () => {
      let nextActiveId = categoryIds[0];

      for (const categoryId of categoryIds) {
        const element = window.document.getElementById(categoryId);
        if (!element) {
          continue;
        }

        if (element.getBoundingClientRect().top <= stickyMetrics.spyOffset) {
          nextActiveId = categoryId;
        }
      }

      setActiveCategoryId(nextActiveId);
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, [filteredCategories, hasVisibleMenuItems, stickyMetrics.spyOffset]);

  const scrollToCategory = (categoryName, index) => {
    const element = window.document.getElementById(categoryDomId(categoryName, index));
    if (!element) {
      return;
    }

    const top = window.scrollY + element.getBoundingClientRect().top - stickyMetrics.anchorOffset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  };

  const handleCategoryBarScroll = () => {
    const container = categoryBarRef.current;
    if (!container) {
      return;
    }

    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    setCategoryScrollState({
      canScrollLeft: container.scrollLeft > 8,
      canScrollRight: container.scrollLeft < maxScrollLeft - 8,
    });
  };

  const scrollCategoryBar = (direction) => {
    const container = categoryBarRef.current;
    if (!container) {
      return;
    }

    container.scrollBy({
      left: direction * Math.max(container.clientWidth * 0.72, 180),
      behavior: 'smooth',
    });
  };

  if (menuStatus === 'loading' && !hasMenuItems) {
    return <div className="loader"></div>;
  }

  return (
    <div
      className="table-menu-page"
      style={{
        '--table-menu-anchor-offset': `${stickyMetrics.anchorOffset}px`,
      }}
    >
      {menuStatus === 'error' && !hasMenuItems && (
        <div className="glass-panel status-card status-card-error">
          <div>
            <strong>No pudimos cargar el menú.</strong>
            <span>{menuError}</span>
          </div>
          <button className="btn btn-primary" type="button" onClick={reloadSession}>
            Reintentar
          </button>
        </div>
      )}

      {menuStatus === 'error' && hasMenuItems && (
        <div className="glass-panel status-card status-card-error">
          <div>
            <strong>El menú quedó visible, pero no pudimos refrescarlo.</strong>
            <span>{menuError}</span>
          </div>
          <button className="btn" type="button" onClick={reloadSession}>
            Reintentar
          </button>
        </div>
      )}

      {menuStatus === 'empty' && (
        <div className="glass-panel status-card">
          <div>
            <strong>Todavía no hay menú disponible.</strong>
            <span>Estamos actualizando la carta. Probá de nuevo en unos minutos o pedile ayuda al mozo.</span>
          </div>
          <button className="btn" type="button" onClick={reloadSession}>
            Reintentar
          </button>
        </div>
      )}

      {hasVisibleMenuItems && (
        <section ref={searchShellRef} className="table-menu-sticky-stack">
          <div
            className={[
              'category-chip-shell',
              categoryScrollState.canScrollLeft ? 'has-scroll-left' : '',
              categoryScrollState.canScrollRight ? 'has-scroll-right' : '',
            ].filter(Boolean).join(' ')}
          >
            {categoryScrollState.canScrollLeft && (
              <button
                className="category-chip-scroll category-chip-scroll-left"
                type="button"
                onClick={() => scrollCategoryBar(-1)}
                aria-label="Ver categorías anteriores"
              >
                <ChevronLeft size={18} />
              </button>
            )}
            <div
              ref={categoryBarRef}
              className="category-chip-bar"
              onScroll={handleCategoryBarScroll}
            >
              {filteredCategories.map((category, index) => (
                <button
                  key={categoryDomId(category.name, index)}
                  className={`category-chip ${activeCategoryId === categoryDomId(category.name, index) ? 'is-active' : ''}`}
                  onClick={() => {
                    setActiveCategoryId(categoryDomId(category.name, index));
                    scrollToCategory(category.name, index);
                  }}
                >
                  <span>{category.name}</span>
                  <span className="category-chip-count">{(category.items || []).length}</span>
                </button>
              ))}
              <button
                className={`category-chip category-chip-search ${(isSearchOpen || normalizedSearch) ? 'is-active' : ''}`}
                type="button"
                onClick={() => setIsSearchOpen((current) => !current)}
                aria-label={(isSearchOpen || normalizedSearch) ? 'Ocultar búsqueda' : 'Buscar platos'}
                title={(isSearchOpen || normalizedSearch) ? 'Ocultar búsqueda' : 'Buscar platos'}
              >
                <Search size={16} />
              </button>
            </div>
            {categoryScrollState.canScrollRight && (
              <button
                className="category-chip-scroll category-chip-scroll-right"
                type="button"
                onClick={() => scrollCategoryBar(1)}
                aria-label="Ver más categorías"
              >
                <ChevronRight size={18} />
              </button>
            )}
          </div>

          {(isSearchOpen || normalizedSearch) && (
            <section className="menu-search-shell glass-panel table-menu-search">
              <label className="menu-search-box">
                <Search size={18} />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Buscar platos, ingredientes o categorías"
                />
              </label>
              <div className="menu-search-meta">
                <span>{hasVisibleMenuItems
                  ? `${filteredCategories.reduce((total, category) => total + category.items.length, 0)} platos visibles`
                  : 'Sin resultados'}</span>
                {normalizedSearch && (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setIsSearchOpen(false);
                    }}
                  >
                    Limpiar
                  </button>
                )}
              </div>
            </section>
          )}
        </section>
      )}

      {isDraftLocked && (
        <div className="glass-panel status-card table-inline-note">
          <div>
            <strong>No se pueden agregar más pedidos.</strong>
            <span>{draftLockedReason}</span>
          </div>
          <Link className="btn" to={`/${tableId}/pedido`}>
            Ver pedido actual
          </Link>
        </div>
      )}

      {menuAvailabilityFeedback && (
        <div className="glass-panel status-card status-card-error">
          <div>
            <strong>Actualizamos tu pedido.</strong>
            <span>{menuAvailabilityFeedback}</span>
          </div>
        </div>
      )}

      {normalizedSearch && hasMenuItems && !hasVisibleMenuItems && (
        <div className="glass-panel status-card">
          <div>
            <strong>No encontramos platos para “{searchQuery}”.</strong>
            <span>Probá con otro nombre, ingrediente o limpiá la búsqueda para volver al menú completo.</span>
          </div>
          <button className="btn" type="button" onClick={() => setSearchQuery('')}>
            Limpiar búsqueda
          </button>
        </div>
      )}

      {hasVisibleMenuItems && (
        <section className="menu-experience">
          {filteredCategories.map((category, index) => (
            <section
              key={category.id || `${category.name}-${index}`}
              id={categoryDomId(category.name, index)}
              className="menu-section"
            >
              <div className="menu-section-header">
                <div>
                  <h2 className="menu-category-title">{category.name}</h2>
                </div>
                <span className="menu-section-count">{(category.items || []).length} opciones</span>
              </div>

              <div className="menu-grid">
                {(category.items || []).map((item) => {
                  const draftQuantity = getCartQuantity(cart, item.id);
                  const alreadyOrdered = wasAlreadyOrdered(activeOrder, item.id);
                  const isUnavailable = item.is_available === false || Number(item.is_available) === 0;

                  return (
                    <article className={`menu-card glass-panel ${isUnavailable ? 'is-unavailable' : ''}`} key={item.id}>
                      <div className="menu-card-top">
                        <div>
                          <div className="menu-card-state-row">
                            {isUnavailable ? (
                              <span className="menu-card-state-pill is-unavailable">
                                No disponible
                              </span>
                            ) : draftQuantity > 0 ? (
                              <span className="menu-card-state-pill is-draft">
                                En tu pedido · {draftQuantity}
                              </span>
                            ) : (
                              <span className="menu-card-state-pill">Disponible</span>
                            )}
                            {alreadyOrdered && (
                              <span className="menu-card-state-pill is-live">Ya pedido</span>
                            )}
                          </div>
                          <h3 className="menu-card-title">{item.name}</h3>
                          <p className="menu-card-desc">{item.description || 'Sin descripción.'}</p>
                        </div>
                        <span className="menu-card-price">{formatMoney(item.price)}</span>
                      </div>

                      <div className="menu-card-actions">
                        {draftQuantity > 0 ? (
                          <div className="menu-card-quantity-actions">
                            <div className="qty-controls menu-card-qty-controls">
                              <button
                                className="qty-btn"
                                type="button"
                                onClick={() => updateQuantity(item.id, -1)}
                              >
                                -
                              </button>
                              <span className="qty-display">{draftQuantity}</span>
                              <button
                                className="qty-btn"
                                type="button"
                                onClick={() => addToCart(item)}
                                disabled={isDraftLocked || isUnavailable}
                              >
                                +
                              </button>
                            </div>
                            <span className="menu-card-draft-note">En borrador</span>
                          </div>
                        ) : (
                          <button
                            className="btn btn-primary menu-add-btn"
                            type="button"
                            onClick={() => addToCart(item)}
                            disabled={isDraftLocked || isUnavailable}
                          >
                            <Plus size={16} /> {isUnavailable ? 'No disponible' : isDraftLocked ? 'Pedido abierto' : 'Agregar'}
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </section>
      )}

      <OrderConfirmedModal isOpen={orderConfirmed} onClose={clearOrderConfirmed} />

      <FloatingOrderDock
        tableId={tableId}
        activeOrder={activeOrder}
        activeOrderItemsCount={activeOrderItemsCount}
        cart={cart}
        cartItemsCount={cart.reduce((sum, item) => sum + item.quantity, 0)}
        cartTotal={cart.reduce((sum, item) => sum + (item.price * item.quantity), 0)}
      />
    </div>
  );
}
