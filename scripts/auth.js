// Authentication module for org sign-in/sign-up

const BASE_PATH = window.location.pathname.replace(/\/+$/, '').replace(/\/index\.html$/i, '');
const API_BASE = `${BASE_PATH}/api`;

const TOKEN_KEY = 'roomdesigner_token';
const ORG_KEY = 'roomdesigner_org';
const USERNAME_KEY = 'roomdesigner_username';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getOrgId() {
  return localStorage.getItem(ORG_KEY);
}

export function getUsername() {
  return localStorage.getItem(USERNAME_KEY);
}

export function isAuthenticated() {
  return !!getToken();
}

export async function logout() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
    } catch (_) {
      // Best-effort server-side revocation
    }
  }
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ORG_KEY);
  localStorage.removeItem(USERNAME_KEY);
  localStorage.removeItem('roomdesigner_admin');
  window.location.href = window.location.pathname.replace(/\/admin\.html$/i, '/');
}

async function authFetch(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(error.detail || `HTTP ${response.status}`);
  }

  return response.json();
}

export async function signUp(username, password) {
  const result = await authFetch('/auth/signup', { username, password });
  localStorage.setItem(TOKEN_KEY, result.token);
  localStorage.setItem(ORG_KEY, result.org_id);
  localStorage.setItem(USERNAME_KEY, result.username);
  return result;
}

export function isAdmin() {
  return localStorage.getItem('roomdesigner_admin') === 'true';
}

export async function signIn(username, password) {
  const result = await authFetch('/auth/signin', { username, password });
  localStorage.setItem(TOKEN_KEY, result.token);
  localStorage.setItem(ORG_KEY, result.org_id);
  localStorage.setItem(USERNAME_KEY, result.username);
  if (result.admin) {
    localStorage.setItem('roomdesigner_admin', 'true');
  }
  return result;
}
