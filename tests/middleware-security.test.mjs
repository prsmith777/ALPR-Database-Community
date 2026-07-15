import assert from 'node:assert/strict';
import { afterEach, test, mock } from 'node:test';

function makeRequest(url, { method = 'GET', headers = {}, body, session } = {}) {
  const nextUrl = new URL(url);
  const normalizedHeaders = new Headers(headers);
  return {
    method,
    url,
    nextUrl,
    headers: normalizedHeaders,
    cookies: {
      get(name) {
        if (name === 'session' && session) return { name, value: session };
        return undefined;
      },
    },
    ip: '192.0.2.10',
    body,
  };
}

async function importMiddleware() {
  return import(`../middleware.js?cache=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  mock.restoreAll();
});

test('malformed HTTP 200 verifier response returns 503', async () => {
  const { middleware } = await importMiddleware();
  mock.method(globalThis, 'fetch', async () => new Response('not-json', { status: 200 }));
  mock.method(console, 'log', () => {});

  const response = await middleware(makeRequest('http://example.test/api/plate-reads', {
    method: 'POST',
    headers: { 'x-api-key': 'secret-key' },
  }));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Authentication temporarily unavailable' });
});

test('{ valid: false } verifier response returns 401', async () => {
  const { middleware } = await importMiddleware();
  mock.method(globalThis, 'fetch', async () => Response.json({ valid: false }, { status: 200 }));
  mock.method(console, 'log', () => {});

  const response = await middleware(makeRequest('http://example.test/api/plate-reads', {
    method: 'POST',
    headers: { authorization: 'Bearer bad-secret' },
  }));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Unauthorized' });
});

test('{ valid: true } verifier response succeeds', async () => {
  const { middleware } = await importMiddleware();
  mock.method(globalThis, 'fetch', async () => Response.json({ valid: true }, { status: 200 }));
  mock.method(console, 'log', () => {});

  const response = await middleware(makeRequest('http://example.test/api/plate-reads', {
    method: 'POST',
    headers: { 'x-api-key': 'good-secret' },
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-middleware-next'), '1');
});

test('captured auth console output omits secrets and full plate-read payloads', async () => {
  const { middleware } = await importMiddleware();
  const apiKey = 'ak_live_should_never_be_logged';
  const bearer = `Bearer ${apiKey}`;
  const sessionId = 'session_id_should_never_be_logged';
  const platePayload = JSON.stringify({
    plate: 'FULLPLATEPAYLOAD',
    camera: 'front-gate',
    image: 'base64-image-data-that-should-not-appear',
  });
  const captured = [];

  mock.method(globalThis, 'fetch', async () => {
    throw new Error(`sensitive ${apiKey} ${bearer} ${sessionId} ${platePayload} /tmp/auth/auth.json`);
  });
  mock.method(console, 'log', (...args) => captured.push(args.map(String).join(' ')));
  mock.method(console, 'error', (...args) => captured.push(args.map(String).join(' ')));

  const response = await middleware(makeRequest('http://example.test/api/plate-reads', {
    method: 'POST',
    headers: { authorization: bearer, cookie: `session=${sessionId}` },
    body: platePayload,
    session: sessionId,
  }));

  assert.equal(response.status, 503);
  const output = captured.join('\n');
  assert(!output.includes(apiKey));
  assert(!output.includes(bearer));
  assert(!output.includes(sessionId));
  assert(!output.includes(platePayload));
  assert(!output.includes('base64-image-data-that-should-not-appear'));
  assert(!output.includes('/tmp/auth/auth.json'));
});
