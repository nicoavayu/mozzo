import { CheckCircle2 } from 'lucide-react';

export default function OrderConfirmedModal({ isOpen, onClose }) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="glass-panel modal-content table-confirm-modal table-order-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-confirmed-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="table-order-confirm-modal-icon" aria-hidden="true">
          <CheckCircle2 size={28} />
        </div>
        <div>
          <span className="table-confirm-modal-kicker">Pedido enviado</span>
          <h2 id="order-confirmed-title">Ya entró a cocina</h2>
          <p className="table-confirm-modal-copy">
            Lo vamos a ir actualizando en tiempo real mientras se prepara. Podés seguir navegando el menú o revisar tus envíos en Mi pedido.
          </p>
        </div>
        <div className="table-confirm-modal-actions">
          <button className="btn btn-primary" type="button" onClick={onClose}>
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
}
