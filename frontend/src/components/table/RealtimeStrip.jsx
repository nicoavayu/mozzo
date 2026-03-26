const SOCKET_STATUS_COPY = {
  connected: {
    label: 'Conectado en vivo',
    helper: 'Actualizaciones activas',
    tone: 'is-connected',
  },
  reconnecting: {
    label: 'Reconectando',
    helper: 'Volvemos a enlazar',
    tone: 'is-warning',
  },
  disconnected: {
    label: 'Sin conexión',
    helper: 'Puede demorarse',
    tone: 'is-danger',
  },
};

export default function RealtimeStrip({ socketStatus }) {
  const config = SOCKET_STATUS_COPY[socketStatus] || SOCKET_STATUS_COPY.disconnected;

  return (
    <div className={`realtime-strip glass-panel ${config.tone}`}>
      <span className="realtime-strip-dot" />
      <strong>{config.label}</strong>
      <span>{config.helper}</span>
    </div>
  );
}
