import axios from 'axios';

const ACCESS_KEY = 'sg.accessToken';
const REFRESH_KEY = 'sg.refreshToken';

export const tokenStore = {
  get access() {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY);
  },
  set({ accessToken, refreshToken }) {
    if (accessToken) localStorage.setItem(ACCESS_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

// Attach the current access token to every request.
api.interceptors.request.use((config) => {
  const token = tokenStore.access;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// --- Silent refresh on 401 (expired access token) -------------------------
let refreshing = null;
let onAuthFailure = () => {};

export function setAuthFailureHandler(fn) {
  onAuthFailure = fn;
}

async function performRefresh() {
  const refreshToken = tokenStore.refresh;
  if (!refreshToken) throw new Error('No refresh token');
  const { data } = await axios.post('/api/auth/refresh', { refreshToken });
  tokenStore.set(data);
  return data.accessToken;
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;
    const isRefreshCall = original?.url?.includes('/auth/refresh');

    if (status === 401 && !original._retry && !isRefreshCall) {
      original._retry = true;
      try {
        refreshing = refreshing || performRefresh();
        const newToken = await refreshing;
        refreshing = null;
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      } catch (err) {
        refreshing = null;
        tokenStore.clear();
        onAuthFailure();
        return Promise.reject(err);
      }
    }
    return Promise.reject(error);
  }
);

/** Statement Generator endpoints (DB-backed patient/DOS/generation workflow). */
export const statementsApi = {
  import: (fileName, rows) => api.post('/statements/import', { fileName, rows }).then((r) => r.data),
  patients: (page = 1, pageSize = 10, search = '') =>
    api
      .get('/statements/patients', { params: { page, pageSize, ...(search ? { search } : {}) } })
      .then((r) => r.data),
  pendingPatients: () => api.get('/statements/patients/pending').then((r) => r.data),
  // Live financial summary (real DB aggregate): total outstanding Patient Responsibility.
  summary: () => api.get('/statements/summary').then((r) => r.data),
  // Roster of every patient + address-validation state (drives "Verify All Addresses").
  addressQueue: () => api.get('/statements/patients/address-queue').then((r) => r.data),
  patientDos: (key) => api.get(`/statements/patients/${encodeURIComponent(key)}/dos`).then((r) => r.data),
  validateAddress: (key) =>
    api.post(`/statements/patients/${encodeURIComponent(key)}/validate-address`).then((r) => r.data),
  // Edit a patient's address directly; USPS auto-formats it and it is saved.
  updateAddress: (key, line1, line2) =>
    api.put(`/statements/patients/${encodeURIComponent(key)}/address`, { line1, line2 }).then((r) => r.data),
  // Live free-tier / SKU usage status for the Address Validation API.
  addressValidationStatus: () =>
    api.get('/statements/address-validation/status').then((r) => r.data),
  generate: (key) => api.post('/statements/generate', { key }).then((r) => r.data),
  // Archive a rendered statement PDF to S3 (raw PDF bytes, not JSON).
  storePdf: (statementId, blob) =>
    api
      .post(`/statements/${statementId}/pdf`, blob, { headers: { 'Content-Type': 'application/pdf' } })
      .then((r) => r.data),
  // Fetch a short-lived presigned URL to download a stored statement PDF.
  downloadUrl: (statementId) =>
    api.get(`/statements/${statementId}/download`).then((r) => r.data),
  // Append an additional PDF to a generated statement (raw PDF bytes; same name kept).
  mergePdf: (statementId, blob) =>
    api
      .post(`/statements/${statementId}/merge`, blob, { headers: { 'Content-Type': 'application/pdf' } })
      .then((r) => r.data),
};

export default api;
