import { BrowserRouter, Routes, Route, useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import Menu from './components/Menu';
import AdminPanel from './components/AdminPanel';
import { ChefHat } from 'lucide-react';

const SOCKET_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
export const socket = io(SOCKET_URL);

function TableView() {
  const { tableId } = useParams();
  
  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <ChefHat size={32} color="var(--accent-color)" />
          <span>Mozzo</span>
        </div>
        <div className="table-badge">Mesa {tableId}</div>
      </header>
      <Menu tableId={tableId} socket={socket} />
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin" element={<AdminPanel socket={socket} />} />
        <Route path="/:tableId" element={<TableView />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
