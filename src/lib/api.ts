/**
 * Thin fetch wrapper for the receiver API.
 *
 * Everything the browser needs is now behind a login: requests carry the
 * HttpOnly session cookie (`credentials: 'same-origin'`), which the receiver
 * sets on `POST /api/auth/login`. Errors are normalised into `ApiError` so the
 * UI can distinguish "not signed in" (401) from a real failure.
 */

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail || `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }
}

/** Fired when the server reports that the session is gone. */
export const AUTH_EXPIRED_EVENT = 'fsms:auth-expired';

async function parseError(res: Response): Promise<ApiError> {
  let detail = res.statusText || 'Request failed';
  try {
    const data = (await res.json()) as { detail?: unknown; error?: unknown };
    if (typeof data?.detail === 'string') detail = data.detail;
    else if (typeof data?.error === 'string') detail = data.error;
  } catch {
    // Non-JSON error body (e.g. an nginx 502 page) — keep the status text.
  }
  return new ApiError(res.status, detail);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  };
  if (body !== undefined) {
    init.headers = { ...(init.headers as Record<string, string>), 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? error.message : 'Network error');
  }

  if (!res.ok) {
    const error = await parseError(res);
    // Let the app drop to the login screen instead of showing raw 401s.
    if (error.isAuthError && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    }
    throw error;
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

/** Build a query string, skipping empty values. */
export function withQuery(path: string, params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}