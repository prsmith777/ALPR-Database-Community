import assert from 'node:assert/strict';
import { afterEach, test, mock } from 'node:test';

function makeRequest(path, { headers = {}, cookie } = {}) {
  const url = new URL(path, 'http://example.test');
  const h = new Headers(headers);
  return {
    method: 'GET',
    url: url.toString(),
    nextUrl: url,
    headers: h,
    cookies: { get: (name) => name === 'session' && cookie ? { value: cookie } : undefined },
  };
}

async function importMiddleware() {
  return await import(`../middleware.js?cache=${Date.now()}-${Math.random()}`);
}

afterEach(() => mock.restoreAll());

test('missing browser session redirects to /login and ignores spoofed X-Forwarded-For', async () => {
  const { middleware } = await importMiddleware();
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }));
  const res = await middleware(makeRequest('/settings', { headers: { 'x-forwarded-for': '127.0.0.1' } }));
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), 'http://example.test/login');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('valid browser session is allowed', async () => {
  const { middleware } = await importMiddleware();
  mock.method(globalThis, 'fetch', async (url) => url.toString().includes('/api/verify-session')
    ? Response.json({ valid: true })
    : Response.json({ updateRequired: false }));
  const res = await middleware(makeRequest('/settings', { cookie: 'valid-session' }));
  assert.equal(res.status, 200);
});

test('invalid and expired browser sessions are rejected and cleared', async () => {
  const { middleware } = await importMiddleware();
  mock.method(globalThis, 'fetch', async () => Response.json({ valid: false }));
  const res = await middleware(makeRequest('/settings', { cookie: 'expired-session' }));
  assert.equal(res.status, 307);
  assert.match(res.headers.get('set-cookie'), /session=/);
  assert.match(res.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(res.headers.get('set-cookie'), /SameSite=Lax/i);
  assert.match(res.headers.get('set-cookie'), /Path=\//i);
});

test('session verifier timeout, network error, HTTP 5xx, and malformed response fail closed', async () => {
  const { middleware } = await importMiddleware();
  for (const impl of [
    async () => { throw new DOMException('timed out', 'AbortError'); },
    async () => { throw new Error('network down'); },
    async () => new Response('error', { status: 503 }),
    async () => Response.json({ nope: true }),
  ]) {
    mock.restoreAll();
    mock.method(console, 'error', () => {});
    mock.method(globalThis, 'fetch', impl);
    const res = await middleware(makeRequest('/settings', { cookie: 'valid-session' }));
    assert.equal(res.status, 307);
    assert.equal(res.headers.get('location'), 'http://example.test/login');
  }
});

test('session-protected API accepts valid session and returns JSON 401/503 for failures', async () => {
  const { middleware } = await importMiddleware();
  mock.method(globalThis, 'fetch', async () => Response.json({ valid: true }));
  assert.equal((await middleware(makeRequest('/api/chat', { cookie: 'valid-session' }))).status, 200);
  mock.restoreAll();
  let missing = await middleware(makeRequest('/api/chat'));
  assert.equal(missing.status, 401);
  assert.equal(await missing.json().then((b) => b.error), 'Unauthorized');
  mock.method(console, 'error', () => {});
  mock.method(globalThis, 'fetch', async () => new Response('error', { status: 503 }));
  let failed = await middleware(makeRequest('/api/chat', { cookie: 'valid-session' }));
  assert.equal(failed.status, 503);
});

test('plate-read API key routes accept x-api-key and Bearer and reject missing, invalid, query, and storage failure', async () => {
  const { middleware } = await importMiddleware();
  mock.method(globalThis, 'fetch', async () => Response.json({ valid: true }));
  assert.equal((await middleware(makeRequest('/api/plate-reads', { headers: { 'x-api-key': 'good-key' } }))).status, 200);
  assert.equal((await middleware(makeRequest('/api/plate-reads', { headers: { authorization: 'Bearer good-key' } }))).status, 200);
  mock.restoreAll();
  assert.equal((await middleware(makeRequest('/api/plate-reads'))).status, 401);
  assert.equal((await middleware(makeRequest('/api/plate-reads?api_key=good-key'))).status, 401);
  mock.method(globalThis, 'fetch', async () => Response.json({ valid: false }));
  assert.equal((await middleware(makeRequest('/api/plate-reads', { headers: { 'x-api-key': 'bad-key' } }))).status, 401);
  mock.restoreAll();
  mock.method(console, 'error', () => {});
  mock.method(globalThis, 'fetch', async () => new Response('error', { status: 503 }));
  assert.equal((await middleware(makeRequest('/api/plate-reads', { headers: { 'x-api-key': 'good-key' } }))).status, 503);
});

test('middleware never calls /api/verify-whitelist', async () => {
  const { middleware } = await importMiddleware();
  const fetchMock = mock.method(globalThis, 'fetch', async (url) => {
    assert(!url.toString().includes('/api/verify-whitelist'));
    return Response.json({ valid: true });
  });
  await middleware(makeRequest('/settings'));
  await middleware(makeRequest('/settings', { cookie: 'session-value' }));
  assert.equal(fetchMock.mock.calls.some((call) => call.arguments[0].toString().includes('/api/verify-whitelist')), false);
});

