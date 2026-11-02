import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { authenticatedResource, connectSession, disconnectSession } from './auth';

// The browser must never keep a token in page storage: any access fails the test.
const forbidden = () => {
  throw new Error('page storage must not be used for credentials');
};
for (const name of ['sessionStorage', 'localStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: { getItem: forbidden, setItem: forbidden, removeItem: forbidden } });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

it('raw files and events are plain same-origin URLs: no token ever rides in a URL', () => {
  assert.equal(authenticatedResource('/api/events'), '/api/events');
  assert.equal(authenticatedResource('/api/raw/a.png?v=1'), '/api/raw/a.png?v=1');
});

it('connecting posts the token once to /api/session and keeps nothing', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response('{"ok":true}', { status: 201 });
  }) as typeof fetch;
  await connectSession(' secret ');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, '/api/session');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { token: 'secret' });
  assert.equal(calls[0]?.init?.credentials, undefined, 'default same-origin credentials');
  await disconnectSession();
  assert.equal(calls[1]?.init?.method, 'DELETE');
});

it('a refused token surfaces the server message', async () => {
  globalThis.fetch = (async () => new Response('{"error":"That token is not valid for this server."}', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(connectSession('nope'), /not valid for this server/);
});
