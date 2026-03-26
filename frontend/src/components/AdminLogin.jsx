import { useState } from 'react';
import { ChefHat, LogIn, Moon, Sun } from 'lucide-react';
import { loginAdmin } from '../lib/adminAuth';

export default function AdminLogin({ onLogin, venueSettings, theme, onToggleTheme }) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const isLight = theme === 'light';

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      const token = await loginAdmin(password);
      onLogin(token);
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`app-container admin-shell admin-auth-shell ${isLight ? 'admin-theme-light' : ''}`}>
      <div className="glass-panel admin-auth-card">
        <div className="admin-auth-card-head">
          <button
            className="theme-toggle admin-theme-toggle"
            type="button"
            onClick={onToggleTheme}
            aria-label={isLight ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro'}
            title={isLight ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro'}
          >
            {isLight ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>

        <div className="admin-auth-brand">
          <ChefHat size={32} color="var(--accent-color)" />
          <div>
            <h1 className="admin-auth-title">{venueSettings.restaurant_name} Admin</h1>
            <p className="admin-auth-copy">{venueSettings.restaurant_subtitle || 'Ingresá la clave de administración.'}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="admin-auth-form">
          <input
            className="admin-input admin-input--compact"
            type="password"
            placeholder="Contraseña de admin"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          {error && (
            <div className="admin-auth-error">
              {error}
            </div>
          )}

          <button className="btn btn-primary" type="submit" disabled={submitting || !password}>
            {submitting ? 'Ingresando...' : <><LogIn size={18} /> Entrar</>}
          </button>
        </form>
      </div>
    </div>
  );
}
