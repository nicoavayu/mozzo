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

export async function loginStaff(loginCode, pin) {
  const data = await apiRequest('/api/admin/staff/sessions', {
    method: 'POST',
    body: {
      login_code: loginCode,
      pin,
    }
  });

  setAdminToken(data.token);
  return data.token;
}

export async function readCurrentAdminSession(token) {
  return apiRequest('/api/admin/session/current', { token });
}

export async function logoutAdminSession(token) {
  try {
    await apiRequest('/api/admin/session/current', {
      method: 'DELETE',
      token,
    });
  } finally {
    clearAdminToken();
  }
}
