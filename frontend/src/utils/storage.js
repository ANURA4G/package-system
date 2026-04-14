/**
 * localStorage helpers for resumable uploads.
 *
 * Key format: "upload_<fileName>_<fileSize>_<lastModified>"
 *
 * Stored value:
 * {
 *   uploadId: string,
 *   fileKey: string,
 *   completedParts: [{ ETag: string, PartNumber: number }],
 *   timestamp: number
 * }
 */

const PREFIX = "upload_";
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

function _buildKey(file) {
  return `${PREFIX}${file.name}_${file.size}_${file.lastModified}`;
}

/**
 * Save the current upload state to localStorage.
 */
export function saveUploadState(file, uploadId, fileKey, completedParts) {
  const key = _buildKey(file);
  const state = {
    uploadId,
    fileKey,
    completedParts,
    timestamp: Date.now(),
  };
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // localStorage full — silently ignore
  }
}

/**
 * Load a previously saved upload state.
 * Returns null if not found or expired.
 */
export function loadUploadState(file) {
  const key = _buildKey(file);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    const state = JSON.parse(raw);

    // Expire after 24 hours
    if (Date.now() - state.timestamp > EXPIRY_MS) {
      localStorage.removeItem(key);
      return null;
    }

    return state;
  } catch {
    return null;
  }
}

/**
 * Clear the upload state for a file.
 */
export function clearUploadState(file) {
  const key = _buildKey(file);
  localStorage.removeItem(key);
}

// ── Auth Session Helpers ──────────────────────────────────────────────────────

const AUTH_TOKEN_KEY = "token";
const AUTH_EXPIRES_AT_KEY = "token_expires_at";

/**
 * Persist the access token and its expiry time to sessionStorage.
 * @param {string} accessToken  - The JWT access token.
 * @param {number} expiresIn    - Lifetime in seconds (from the server's expires_in field).
 */
export function storeAuthSession(accessToken, expiresIn) {
  try {
    sessionStorage.setItem(AUTH_TOKEN_KEY, accessToken);
    if (expiresIn && expiresIn > 0) {
      const expiresAt = Date.now() + expiresIn * 1000;
      sessionStorage.setItem(AUTH_EXPIRES_AT_KEY, String(expiresAt));
    }
  } catch {
    // Ignore storage write failures in restricted browser contexts.
  }
}

/**
 * Retrieve the stored access token, or null if absent.
 */
export function getAccessToken() {
  try {
    return sessionStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Return the timestamp (ms since epoch) at which the stored access token expires,
 * or null if not known.
 */
export function getTokenExpiresAt() {
  try {
    const raw = sessionStorage.getItem(AUTH_EXPIRES_AT_KEY);
    if (!raw) return null;
    const ts = Number(raw);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

/**
 * Remove all auth session data from sessionStorage.
 */
export function clearAuthSession() {
  try {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    sessionStorage.removeItem(AUTH_EXPIRES_AT_KEY);
  } catch {
    // Ignore storage errors.
  }
}
