/**
 * The browser never holds a token. The Connect screen trades one for an HttpOnly session cookie
 * (`POST /api/session`), and from then on every same-origin request, `<img>` and EventSource
 * carries the cookie by itself. The desktop app's shell injects its own Authorization header, and
 * loopback needs nothing at all.
 */

export interface SessionStatus {
  /** How this request was authenticated: `cookie` for a browser session, `bearer` in the desktop app, `loopback` on the server's own machine. */
  via: 'loopback' | 'bearer' | 'cookie' | 'query' | 'public';
  session: { created: number; lastSeen: number; expires: number } | null;
}

async function sessionRequest(method: 'POST' | 'DELETE', body?: unknown): Promise<Response> {
  return fetch('/api/session', {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Open a browser session with a server token. Throws with the server's message when refused. */
export async function connectSession(token: string): Promise<void> {
  const res = await sessionRequest('POST', { token: token.trim() });
  if (!res.ok) {
    const err = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(err?.error ?? `Could not connect (${res.status}).`);
  }
}

export async function disconnectSession(): Promise<void> {
  await sessionRequest('DELETE');
}

export async function sessionStatus(): Promise<SessionStatus> {
  const res = await fetch('/api/session');
  if (!res.ok) throw new Error(`Could not read the session (${res.status}).`);
  return (await res.json()) as SessionStatus;
}

/** Raw files and events used to need `?token=`. The session cookie covers them now. */
export function authenticatedResource(url: string): string {
  return url;
}

/** Raised when the server stops accepting this browser (session expired or ended elsewhere). */
export const UNAUTHORIZED_EVENT = 'centcom:unauthorized';
