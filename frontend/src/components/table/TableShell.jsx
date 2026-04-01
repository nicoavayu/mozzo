import { useEffect } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import useTableSession from '../../hooks/useTableSession';
import TableHeaderCompact from './TableHeaderCompact';

export default function TableShell({ socket, venueSettings }) {
  const { tableId } = useParams();
  const tableSession = useTableSession(tableId, socket);

  useEffect(() => {
    window.document.body.classList.add('table-theme-light');

    return () => {
      window.document.body.classList.remove('table-theme-light');
    };
  }, []);

  return (
    <div className="app-container table-flow-shell table-theme-light">
      <TableHeaderCompact
        tableId={tableId}
        venueSettings={venueSettings}
        activeOrder={tableSession.activeOrder}
      />
      <Outlet context={{ tableId, venueSettings, ...tableSession }} />
    </div>
  );
}
