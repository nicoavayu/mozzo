import { useState } from 'react';
import { ChefHat, LogIn, Moon, Sun } from 'lucide-react';
import { loginAdmin, loginStaff } from '../lib/adminAuth';

export default function AdminLogin({ onLogin, venueSettings, theme, onToggleTheme }) {
  const [mode, setMode] = useState('owner');
  const [password, setPassword] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const isLight = theme === 'light';

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      const token = mode === 'owner'
        ? await loginAdmin(password)
        : await loginStaff(loginCode, pin);
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
            <p className="admin-auth-copy">
              {mode === 'owner'
                ? (venueSettings.restaurant_subtitle || 'Ingresá la clave de administración.')
                : 'Ingresá tu código y PIN operativo.'}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="admin-auth-form">
          <div className="admin-auth-mode-switch">
            <button
              className={`btn ${mode === 'owner' ? 'btn-primary' : ''}`}
              type="button"
              onClick={() => {
                setMode('owner');
                setError('');
              }}
            >
              Owner
            </button>
            <button
              className={`btn ${mode === 'staff' ? 'btn-primary' : ''}`}
              type="button"
              onClick={() => {
                setMode('staff');
                setError('');
              }}
            >
              Staff
            </button>
          </div>

          {mode === 'owner' ? (
            <input
              className="admin-input admin-input--compact"
              type="password"
              placeholder="Contraseña de admin"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          ) : (
            <>
              <input
                className="admin-input admin-input--compact"
                type="text"
                placeholder="Código de acceso"
                value={loginCode}
                onChange={(event) => setLoginCode(event.target.value.toUpperCase())}
                autoCapitalize="characters"
                autoCorrect="off"
              />
              <input
                className="admin-input admin-input--compact"
                type="password"
                placeholder="PIN"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                inputMode="numeric"
              />
            </>
          )}

          {error && (
            <div className="admin-auth-error">
              {error}
            </div>
          )}

          <button
            className="btn btn-primary"
            type="submit"
            disabled={submitting || (mode === 'owner' ? !password : !loginCode || !pin)}
          >
            {submitting ? 'Ingresando...' : <><LogIn size={18} /> Entrar</>}
          </button>
        </form>
      </div>
    </div>
  );
}
