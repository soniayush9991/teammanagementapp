/**
 * The single place the app talks to the API.
 *
 * The access token is held in memory only — never localStorage — so an XSS
 * cannot read it from storage. The refresh token lives in an httpOnly cookie
 * the browser attaches automatically. When a request comes back 401 because
 * the access token expired, the client refreshes once and replays the
 * original request; concurrent 401s share that one refresh.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE_URL = '/api/v1';

let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;
/** Shared in-flight refresh, so ten parallel 401s cause one refresh. */
let refreshInFlight: Promise<boolean> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function onSessionExpired(handler: () => void): void {
  onSessionLost = handler;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Set for the refresh call itself, to avoid recursing. */
  skipRefresh?: boolean;
}

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) return false;
      const session = (await response.json()) as { accessToken: string };
      accessToken = session.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this promise all see
      // the same result before a new refresh can start.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();
  return refreshInFlight;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> =>
    fetch(`${BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'include',
      signal: options.signal,
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

  let response = await send();

  if (response.status === 401 && !options.skipRefresh) {
    const body = (await parse(response)) as { error?: { code?: string } } | null;
    const code = body?.error?.code;
    // Only an expired or stale token is worth retrying; a wrong password is not.
    if (code === 'token_expired' || code === 'token_stale' || code === 'unauthorized') {
      if (await refreshSession()) {
        response = await send();
      } else {
        accessToken = null;
        onSessionLost?.();
        throw new ApiError(401, 'session_expired', 'Your session has expired, please sign in again');
      }
    } else {
      throw new ApiError(401, code ?? 'unauthorized', 'Authentication required');
    }
  }

  if (response.status === 204) return null as T;

  const payload = await parse(response);
  if (!response.ok) {
    const error = (payload as { error?: { code: string; message: string; details?: unknown } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? `Request failed with ${response.status}`,
      error?.details,
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** Builds a query string, dropping undefined and empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/**
 * Report exports come back as a file rather than JSON, so they bypass the
 * JSON helper and trigger a download.
 */
export async function downloadReport(path: string, filename: string): Promise<void> {
  const response = await fetch(`${BASE_URL}${path}`, {
    credentials: 'include',
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
  if (!response.ok) {
    throw new ApiError(response.status, 'export_failed', 'The export could not be generated');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
