import { useEffect, useState } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import useTableSession from '../../hooks/useTableSession';
import TableHeaderCompact from './TableHeaderCompact';

const TABLE_THEME_STORAGE_KEY = 'mozzo-table-theme';

export default function TableShell({ socket, venueSettings }) {
  const { tableId } = useParams();
  const tableSession = useTableSession(tableId, socket);
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') {
      return 'dark';
    }

    return window.localStorage.getItem(TABLE_THEME_STORAGE_KEY) || 'dark';
  });

  useEffect(() => {
    window.localStorage.setItem(TABLE_THEME_STORAGE_KEY, theme);
    window.document.body.classList.toggle('table-theme-light', theme === 'light');

    return () => {
      window.document.body.classList.remove('table-theme-light');
    };
  }, [theme]);

  return (
    <div className={`app-container table-flow-shell ${theme === 'light' ? 'table-theme-light' : ''}`}>
      <TableHeaderCompact
        tableId={tableId}
        socketStatus={tableSession.socketStatus}
        venueSettings={venueSettings}
        theme={theme}
        onToggleTheme={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
      />
      <Outlet context={{ tableId, venueSettings, ...tableSession }} />
    </div>
  );
}
