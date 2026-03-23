import { useState, useEffect } from 'react';
import { ShoppingBag, Plus, Minus, X, CheckCircle, Send } from 'lucide-react';

export default function Menu({ tableId, socket }) {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState([]);
  const [showCartContent, setShowCartContent] = useState(false);
  const [orderConfirmed, setOrderConfirmed] = useState(false);

  useEffect(() => {
    const fetchMenu = () => {
      fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3000'}/api/menu`)
        .then(res => res.json())
        .then(data => {
          setCategories(data);
          setLoading(false);
        });
    };
    
    fetchMenu();

    socket.on('menu_updated', () => {
        fetchMenu();
    });

    socket.on('order_confirmed', (order) => {
      if(order.table_id == tableId) {
          setOrderConfirmed(true);
          setCart([]);
          setShowCartContent(false);
          setTimeout(() => setOrderConfirmed(false), 3000);
      }
    });

    socket.on('order_status_updated', ({order_id, status}) => {
       // Just as an example, this could show a toast to the user
       console.log(`Order ${order_id} status changed to ${status}`);
    });

    return () => {
      socket.off('order_confirmed');
      socket.off('order_status_updated');
      socket.off('menu_updated');
    };
  }, [tableId, socket]);

  const addToCart = (item) => {
    setCart(prev => {
      const existing = prev.find(i => i.id === item.id);
      if (existing) {
        return prev.map(i => i.id === item.id ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, { ...item, quantity: 1, comments: '' }];
    });
  };

  const updateQuantity = (itemId, delta) => {
    setCart(prev => {
      return prev.map(item => {
        if (item.id === itemId) {
          const newQty = item.quantity + delta;
          return { ...item, quantity: Math.max(0, newQty) };
        }
        return item;
      }).filter(item => item.quantity > 0);
    });
  };

  const updateComment = (itemId, comment) => {
    setCart(prev => prev.map(item => item.id === itemId ? { ...item, comments: comment } : item));
  };

  const placeOrder = () => {
    if (cart.length === 0) return;
    socket.emit('place_order', {
      table_id: parseInt(tableId),
      items: cart
    });
  };

  const cartTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const cartItemsCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  if (loading) return <div className="loader"></div>;

  return (
    <>
      {categories.map(cat => (
        <div key={cat.id}>
          <h2 className="menu-category-title">{cat.name}</h2>
          <div className="menu-grid">
            {cat.items.map(item => (
              <div className="menu-card glass-panel" key={item.id}>
                <div className="menu-card-header">
                  <h3 className="menu-card-title">{item.name}</h3>
                  <span className="menu-card-price">${item.price.toFixed(2)}</span>
                </div>
                <p className="menu-card-desc">{item.description}</p>
                <div className="menu-card-actions">
                  <button className="btn" onClick={() => addToCart(item)}>
                    <Plus size={16} /> Agregar
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {orderConfirmed && (
        <div style={{position:'fixed', top: '20px', right: '20px', background: 'var(--success)', padding: '16px 24px', borderRadius: '12px', zIndex: 1000, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold'}}>
            <CheckCircle size={24} color="white" />
            ¡Pedido Enviado a Cocina!
        </div>
      )}

      {cartItemsCount > 0 && !showCartContent && (
        <div className="floating-cart-wrapper">
          <div className="floating-cart" onClick={() => setShowCartContent(true)}>
            <div className="cart-info">
              <span className="cart-items">{cartItemsCount} {cartItemsCount === 1 ? 'ítem' : 'ítems'}</span>
              <span className="cart-total">${cartTotal.toFixed(2)}</span>
            </div>
            <div style={{display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold'}}>
                Ver Pedido <ShoppingBag size={20} />
            </div>
          </div>
        </div>
      )}

      {showCartContent && (
        <div className="modal-overlay" onClick={() => setShowCartContent(false)}>
          <div className="modal-content glass-panel" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Tu Pedido (Mesa {tableId})</h2>
              <button className="close-btn" onClick={() => setShowCartContent(false)}>
                <X size={24} />
              </button>
            </div>
            
            <div className="cart-items-list">
              {cart.map(item => (
                <div className="cart-item-row" key={item.id}>
                  <div className="cart-item-details">
                    <div className="cart-item-name">{item.name}</div>
                    <div className="cart-item-price">${(item.price * item.quantity).toFixed(2)}</div>
                    <textarea 
                      className="cart-comment-input" 
                      placeholder="Comentarios (ej: sin cebolla)..."
                      value={item.comments}
                      onChange={(e) => updateComment(item.id, e.target.value)}
                    ></textarea>
                  </div>
                  <div className="qty-controls">
                    <button className="qty-btn" onClick={() => updateQuantity(item.id, -1)}><Minus size={16}/></button>
                    <span className="qty-display">{item.quantity}</span>
                    <button className="qty-btn" onClick={() => updateQuantity(item.id, 1)}><Plus size={16}/></button>
                  </div>
                </div>
              ))}
            </div>

            <div className="cart-footer">
              <div className="grand-total">Total: ${cartTotal.toFixed(2)}</div>
              <button className="btn btn-primary" onClick={placeOrder}>
                Enviar <Send size={18} />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
