import { useState, useEffect } from 'react';
import { ChefHat, Check, Clock, Play, Upload, Save, X } from 'lucide-react';

export default function AdminPanel({ socket }) {
  const [orders, setOrders] = useState([]);
  const [activeTab, setActiveTab] = useState('kanban');
  
  // Menu Import State
  const [file, setFile] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [parsedMenu, setParsedMenu] = useState(null);

  useEffect(() => {
    socket.emit('join_admin');

    fetch('http://localhost:3000/api/orders')
      .then(res => res.json())
      .then(data => setOrders(data));

    socket.on('new_order', (order) => {
      setOrders(prev => [order, ...prev]);
      if (Notification.permission === 'granted') {
          new Notification('Nuevo Pedido - Mesa ' + order.table_id);
      }
    });

    socket.on('order_status_updated', ({ order_id, status }) => {
      setOrders(prev => prev.map(o => o.id === order_id ? { ...o, status } : o));
    });

    return () => {
      socket.off('new_order');
      socket.off('order_status_updated');
    };
  }, [socket]);

  const updateStatus = (orderId, newStatus) => {
    socket.emit('update_order_status', { order_id: orderId, status: newStatus });
  };

  const handleFileUpload = async (e) => {
      e.preventDefault();
      if(!file) return;
      
      setIsProcessing(true);
      const formData = new FormData();
      formData.append('menuImage', file);
      
      try {
          const res = await fetch('http://localhost:3000/api/menu/upload', {
              method: 'POST',
              body: formData
          });
          if(!res.ok) throw new Error(await res.text());
          const data = await res.json();
          setParsedMenu(data.categories || data);
      } catch(e) {
          alert('Error: ' + e.message);
      } finally {
          setIsProcessing(false);
      }
  };

  const publishMenu = async () => {
      try {
          const res = await fetch('http://localhost:3000/api/menu/publish', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ categories: parsedMenu })
          });
          if(res.ok) {
              alert('Menú publicado exitosamente.');
              setParsedMenu(null);
              setFile(null);
              setActiveTab('kanban');
          }
      } catch(e) {
          alert('Error al publicar: ' + e.message);
      }
  };

  const updateParsedItem = (catIdx, itemIdx, field, value) => {
      const newMenu = [...parsedMenu];
      newMenu[catIdx].items[itemIdx][field] = value;
      setParsedMenu(newMenu);
  };
  
  const updateParsedCat = (catIdx, value) => {
      const newMenu = [...parsedMenu];
      newMenu[catIdx].name = value;
      setParsedMenu(newMenu);
  };

  const pendingOrders = orders.filter(o => o.status === 'pending');
  const processingOrders = orders.filter(o => o.status === 'processing');
  const readyOrders = orders.filter(o => o.status === 'ready');

  const renderOrderCard = (order) => (
    <div className="order-card" key={order.id}>
      <div className="order-header">
        <span className="table-badge">Mesa {order.table_id}</span>
        <span className="time">{new Date(order.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
      </div>
      <ul className="order-items-list">
        {order.items.map((item, idx) => (
          <li key={idx}>
            <span className="item-qty">{item.quantity}x</span> {item.name}
            {item.comments && <span className="item-comment">"{item.comments}"</span>}
          </li>
        ))}
      </ul>
      <div className="order-actions">
        {order.status === 'pending' && (
          <button className="btn" onClick={() => updateStatus(order.id, 'processing')} style={{color: 'var(--warning)', borderColor: 'var(--warning)'}}>
            <Play size={16} /> Preparar
          </button>
        )}
        {order.status === 'processing' && (
          <button className="btn" onClick={() => updateStatus(order.id, 'ready')} style={{color: 'var(--success)', borderColor: 'var(--success)'}}>
            <Check size={16} /> Listo
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <ChefHat size={32} color="var(--accent-color)" />
          <span>Mozzo Admin</span>
        </div>
        <div style={{display: 'flex', gap: '10px'}}>
            <button className={`btn ${activeTab === 'kanban' ? 'btn-primary' : ''}`} onClick={() => setActiveTab('kanban')}>Tablero Realtime</button>
            <button className={`btn ${activeTab === 'menu_import' ? 'btn-primary' : ''}`} onClick={() => setActiveTab('menu_import')}>Importar Menú (Foto)</button>
        </div>
      </header>

      {activeTab === 'kanban' && (
          <div className="admin-grid">
            <div className="admin-column" style={{borderTop: `4px solid var(--danger)`}}>
              <div className="column-header">
                <Clock size={20} color="var(--danger)" /> Pendientes <span className="badge">{pendingOrders.length}</span>
              </div>
              {pendingOrders.map(renderOrderCard)}
            </div>
            <div className="admin-column" style={{borderTop: `4px solid var(--warning)`}}>
              <div className="column-header">
                <Play size={20} color="var(--warning)" /> En Preparación <span className="badge">{processingOrders.length}</span>
              </div>
              {processingOrders.map(renderOrderCard)}
            </div>
            <div className="admin-column" style={{borderTop: `4px solid var(--success)`}}>
              <div className="column-header">
                <Check size={20} color="var(--success)" /> Listos <span className="badge">{readyOrders.length}</span>
              </div>
              {readyOrders.map(renderOrderCard)}
            </div>
          </div>
      )}

      {activeTab === 'menu_import' && (
          <div className="glass-panel" style={{padding: '30px', animation: 'fadeIn 0.4s'}}>
             <h2 style={{marginBottom: '10px'}}>Subir Nuevo Menú desde una Foto</h2>
             <p style={{color: 'var(--text-secondary)', marginBottom: '30px'}}>Nuestra Inteligencia Artificial usa OCR (Tesseract) y NLP (spaCy) para transcribir y estructurar la fotografía de tu menú en etiquetas digitales interactivas.</p>
             
             {!parsedMenu ? (
                 <form onSubmit={handleFileUpload} style={{display: 'flex', flexDirection: 'column', gap: '20px', alignItems: 'flex-start'}}>
                     <div style={{border: '2px dashed var(--border-color)', padding: '40px', borderRadius: '12px', width: '100%', textAlign: 'center'}}>
                         <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files[0])} style={{color: 'var(--text-primary)'}} />
                     </div>
                     <button className="btn btn-primary" type="submit" disabled={!file || isProcessing}>
                         {isProcessing ? 'Analizando con IA...' : <><Upload size={18}/> Analizar con OCR y NLP</>}
                     </button>
                 </form>
             ) : (
                 <div>
                    <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', paddingBottom: '20px', borderBottom: '1px solid var(--border-color)'}}>
                        <h3 style={{color: 'var(--warning)'}}>Modo de Corrección. Revisa el borrador generado:</h3>
                        <div style={{display: 'flex', gap: '10px'}}>
                            <button className="btn" onClick={() => setParsedMenu(null)}>Descartar Foto <X size={16}/></button>
                            <button className="btn btn-primary" onClick={publishMenu}>Guardar y Publicar en la App <Save size={16}/></button>
                        </div>
                    </div>
                    
                    {parsedMenu.map((cat, cIdx) => (
                        <div key={cIdx} style={{marginBottom: '40px', background: 'var(--bg-surface)', padding: '20px', borderRadius: '12px'}}>
                            <div style={{display: 'flex', alignItems: 'center', marginBottom: '16px', gap: '12px'}}>
                                <h4>Clase Identificada:</h4>
                                <input className="cart-comment-input" style={{marginTop: 0, padding:'8px 12px', width: '250px', minHeight: 'auto'}} value={cat.name} onChange={e => updateParsedCat(cIdx, e.target.value)} />
                            </div>
                            
                            <table style={{width: '100%', textAlign: 'left', borderCollapse: 'collapse'}}>
                                <thead>
                                    <tr style={{borderBottom: '1px solid var(--border-color)'}}>
                                        <th style={{padding: '12px'}}>Plato Extraído</th>
                                        <th style={{padding: '12px', width: '120px'}}>Precio ($)</th>
                                        <th style={{padding: '12px'}}>Descripción Extraída (Opcional)</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {(cat.items || []).map((item, iIdx) => (
                                        <tr key={iIdx} style={{borderBottom: '1px solid var(--border-color)'}}>
                                            <td style={{padding: '8px'}}><input className="cart-comment-input" style={{margin:0, padding:'8px', minHeight: 'auto', background: 'transparent'}} value={item.name} onChange={e => updateParsedItem(cIdx, iIdx, 'name', e.target.value)} /></td>
                                            <td style={{padding: '8px'}}><input className="cart-comment-input" style={{margin:0, padding:'8px', minHeight: 'auto', background: 'transparent'}} value={item.price} type="number" step="0.01" onChange={e => updateParsedItem(cIdx, iIdx, 'price', e.target.value)} /></td>
                                            <td style={{padding: '8px'}}><input className="cart-comment-input" style={{margin:0, padding:'8px', minHeight: 'auto', background: 'transparent'}} value={item.description} onChange={e => updateParsedItem(cIdx, iIdx, 'description', e.target.value)} /></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ))}
                 </div>
             )}
          </div>
      )}
    </div>
  );
}
