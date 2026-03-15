// Authentication module for org sign-in

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
  localStorage.removeItem('roomdesigner_impersonating');
  localStorage.removeItem('roomdesigner_impersonate_username');
  localStorage.removeItem('roomdesigner_admin_token');
  localStorage.removeItem('roomdesigner_admin_org');
  localStorage.removeItem('roomdesigner_admin_username');
  localStorage.removeItem('roomdesigner_demo_mode');
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
  if (result.demo_mode) {
    localStorage.setItem('roomdesigner_demo_mode', 'true');
  } else {
    localStorage.removeItem('roomdesigner_demo_mode');
  }
  return result;
}

export function isDemoMode() {
  return localStorage.getItem('roomdesigner_demo_mode') === 'true';
}

export function isImpersonating() {
  return localStorage.getItem('roomdesigner_impersonating') === 'true';
}

export function getImpersonateUsername() {
  return localStorage.getItem('roomdesigner_impersonate_username');
}

export function exitImpersonation() {
  const adminToken = localStorage.getItem('roomdesigner_admin_token');
  const adminOrg = localStorage.getItem('roomdesigner_admin_org');
  const adminUsername = localStorage.getItem('roomdesigner_admin_username');

  localStorage.setItem(TOKEN_KEY, adminToken);
  localStorage.setItem(ORG_KEY, adminOrg);
  localStorage.setItem(USERNAME_KEY, adminUsername);
  localStorage.setItem('roomdesigner_admin', 'true');

  localStorage.removeItem('roomdesigner_impersonating');
  localStorage.removeItem('roomdesigner_impersonate_username');
  localStorage.removeItem('roomdesigner_admin_token');
  localStorage.removeItem('roomdesigner_admin_org');
  localStorage.removeItem('roomdesigner_admin_username');
  localStorage.removeItem('roomdesigner_demo_mode');

  const basePath = window.location.pathname.replace(/\/+$/, '').replace(/\/index\.html$/i, '');
  window.location.href = `${basePath}/admin.html`;
}
