/**
 * Shared API base URL resolver.
 *
 * When `VITE_API_BASE_URL` is unset (the default for a freshly deployed
 * frontend), the app falls back to the deployed backend on Render so that
 * production users don't hit the frontend origin (Vercel) with API requests
 * and see HTML 404 responses. Local dev keeps an empty string so devs must
 * set `VITE_API_BASE_URL` to opt in, mirroring the previous behavior.
 *
 * This is the same logic that was added to `apiService.ts` in commit
 * `152bae4`; it lives here so every service can share it and stay in sync.
 */
const DEPLOYED_BACKEND_FALLBACK = 'https://coachxai-server.onrender.com';

export function resolveApiBaseUrl(): string {
  const envUrl = import.meta.env.VITE_API_BASE_URL;
  if (envUrl) return envUrl.replace(/\/$/, '');
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      return DEPLOYED_BACKEND_FALLBACK;
    }
  }
  return '';
}

/** localStorage key holding the server's login JWT (written by apiService). */
export const API_TOKEN_KEY = 'swingnote_api_token';

/**
 * Headers for a JSON request to our server, with the login token when there
 * is one. The AI gateway (/api/ai/invoke, /invoke-stream) rejects calls
 * without a coach token, so every AI fetch must go through this.
 */
export function jsonAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem(API_TOKEN_KEY) : null;
    if (token && token !== 'undefined' && token !== 'null') {
      headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // storage blocked (private mode etc.): send without a token
  }
  return headers;
}
