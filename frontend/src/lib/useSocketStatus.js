import { useEffect, useState } from 'react';

export function useSocketStatus(socket) {
  const [status, setStatus] = useState(socket.connected ? 'connected' : 'reconnecting');

  useEffect(() => {
    const handleConnect = () => setStatus('connected');
    const handleDisconnect = () => setStatus('reconnecting');
    const handleConnectError = () => setStatus(socket.active ? 'reconnecting' : 'disconnected');
    const handleReconnectAttempt = () => setStatus('reconnecting');
    const handleReconnect = () => setStatus('connected');
    const handleReconnectFailed = () => setStatus('disconnected');

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.io.on('reconnect_attempt', handleReconnectAttempt);
    socket.io.on('reconnect', handleReconnect);
    socket.io.on('reconnect_failed', handleReconnectFailed);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.io.off('reconnect_attempt', handleReconnectAttempt);
      socket.io.off('reconnect', handleReconnect);
      socket.io.off('reconnect_failed', handleReconnectFailed);
    };
  }, [socket]);

  return status;
}
