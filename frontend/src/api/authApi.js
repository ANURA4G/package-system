import axios from "axios";
import { storeAuthSession, getAccessToken, clearAuthSession } from "../utils/storage";

const API_BASE = import.meta.env.VITE_API_AUTH_BASE || "/api/auth";

const api = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
  withCredentials: true, // needed for HttpOnly refresh cookie
});

api.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Silent refresh state ──────────────────────────────────────────────────────

let _refreshPromise = null;

/**
 * Perform a token refresh. Returns the new access token on success, or throws.
 * Uses a single-flight pattern so concurrent callers share one refresh request.
 */
export async function silentRefresh() {
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = api
    .post("/refresh")
    .then(({ data }) => {
      storeAuthSession(data.access_token, data.expires_in);
      return data.access_token;
    })
    .finally(() => {
      _refreshPromise = null;
    });

  return _refreshPromise;
}

// ── Response interceptor: retry once after silent refresh on 401 ──────────────

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (
      error.response?.status === 401 &&
      !original._retried &&
      // Never retry the refresh or login endpoints to avoid loops.
      !original.url?.includes("/refresh") &&
      !original.url?.includes("/login")
    ) {
      original._retried = true;
      try {
        const newToken = await silentRefresh();
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      } catch {
        // Refresh failed — caller must handle the 401.
      }
    }
    return Promise.reject(error);
  },
);

// ── Public API ────────────────────────────────────────────────────────────────

export async function loginUser(username, password) {
  const { data } = await api.post("/login", { username, password });
  storeAuthSession(data.access_token, data.expires_in);
  return data;
}

export async function registerUser(username, password) {
  const { data } = await api.post("/register", { username, password });
  return data;
}

export async function getCurrentUser() {
  const { data } = await api.get("/me");
  return data;
}

export async function logoutUser() {
  try {
    await api.post("/logout");
  } catch {
    // Best-effort — always clear local session.
  } finally {
    clearAuthSession();
  }
}
