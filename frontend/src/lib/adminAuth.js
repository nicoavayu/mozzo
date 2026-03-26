import { apiRequest } from './api';

const ADMIN_TOKEN_KEY = 'mozzo.adminToken';

export function getAdminToken() {
  return window.localStorage.getItem(ADMIN_TOKEN_KEY);
}

export function setAdminToken(token) {
  window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken() {
  window.localStorage.removeItem(ADMIN_TOKEN_KEY);
}

export function getAdminAuthHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function loginAdmin(password) {
  const data = await apiRequest('/api/admin/login', {
    method: 'POST',
    body: { password }
  });

  setAdminToken(data.token);
  return data.token;
}
