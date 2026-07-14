import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, mock } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const realAuthPath = path.join(process.cwd(), 'auth', 'auth.json');
let tempDir;
let oldEnv;
let auth;

async function importAuth() {
  const mod = await import(`../lib/auth.js?cache=${Date.now()}-${Math.random()}`);
  mod.resetAuthCacheForTests();
  return mod;
}

async function writeAuth(apiKey = 'test-secret') {
  const authPath = path.join(tempDir, 'auth.json');
  process.env.ALPR_AUTH_FILE_PATH = authPath;
  await fs.mkdir(path.dirname(authPath), { recursive: true });
  await fs.writeFile(authPath, JSON.stringify({ password: '$2b$10$abcdefghijklmnopqrstuu', apiKey, sessions: {} }));
  auth.resetAuthCacheForTests();
  return authPath;
}

beforeEach(async () => {
  oldEnv = { ...process.env };
  process.env.NODE_ENV = 'test';
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alpr-auth-'));
  auth = await importAuth();
});

afterEach(async () => {
  mock.restoreAll();
  if (auth) auth.resetAuthCacheForTests?.();
  process.env = oldEnv;
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('test auth isolation fails safe without ALPR_AUTH_FILE_PATH', async () => {
  delete process.env.ALPR_AUTH_FILE_PATH;
  mock.method(console, 'error', () => {});
  await assert.rejects(() => auth.getAuthConfig(), /ALPR_AUTH_FILE_PATH/);
});

test('verifyApiKey accepts equal values with constant-time comparison', async () => {
  await writeAuth('same-secret');
  assert.equal(await auth.verifyApiKey('same-secret'), true);
});

test('verifyApiKey rejects unequal equal-length values', async () => {
  await writeAuth('same-secret');
  assert.equal(await auth.verifyApiKey('xxxx-secret'), false);
});

test('verifyApiKey rejects unequal byte lengths without throwing', async () => {
  await writeAuth('short');
  await assert.doesNotReject(() => auth.verifyApiKey('a-much-longer-secret'));
  assert.equal(await auth.verifyApiKey('a-much-longer-secret'), false);
});

test('API request helper rejects query-string API keys', async () => {
  await writeAuth('query-secret');
  const req = new Request('http://example.test/api/plate-reads?api_key=query-secret');
  assert.deepEqual(await auth.authorizeApiRequest(req), { ok: false, status: 401 });
});

test('API request helper accepts x-api-key authentication', async () => {
  await writeAuth('header-secret');
  const req = new Request('http://example.test/api/plates', { headers: { 'x-api-key': 'header-secret' } });
  assert.equal((await auth.authorizeApiRequest(req)).ok, true);
});

test('API request helper accepts Authorization Bearer authentication', async () => {
  await writeAuth('bearer-secret');
  const req = new Request('http://example.test/api/plates', { headers: { authorization: 'Bearer bearer-secret' } });
  assert.equal((await auth.authorizeApiRequest(req)).ok, true);
});

test('API request helper returns 401 for missing or invalid credentials', async () => {
  await writeAuth('real-secret');
  assert.equal((await auth.authorizeApiRequest(new Request('http://example.test/api/plates'))).status, 401);
  assert.equal((await auth.authorizeApiRequest(new Request('http://example.test/api/plates', { headers: { 'x-api-key': 'bad-secret' } }))).status, 401);
});

test('API request helper returns 503 when auth storage is unavailable', async () => {
  mock.method(console, 'error', () => {});
  process.env.ALPR_AUTH_FILE_PATH = path.join(tempDir, 'missing', 'auth.json');
  delete process.env.ADMIN_PASSWORD;
  auth.resetAuthCacheForTests();
  const req = new Request('http://example.test/api/plates', { headers: { 'x-api-key': 'anything' } });
  assert.deepEqual(await auth.authorizeApiRequest(req), { ok: false, status: 503 });
});

test('session validation covers valid, missing, invalid, and expired sessions', async () => {
  const now = Date.now();
  const authPath = await writeAuth('session-secret');
  await fs.mkdir(path.dirname(authPath), { recursive: true });
  await fs.writeFile(authPath, JSON.stringify({
    password: '$2b$10$abcdefghijklmnopqrstuu',
    apiKey: 'session-secret',
    sessions: {
      valid: { id: 'valid', userAgent: 'test', createdAt: now, lastUsed: now, expiresAt: now + 60000 },
      expired: { id: 'expired', userAgent: 'test', createdAt: now - 120000, lastUsed: now - 120000, expiresAt: now - 1 }
    }
  }));
  auth.resetAuthCacheForTests();
  assert.equal(await auth.verifySession('valid'), true);
  assert.equal(await auth.verifySession(), false);
  assert.equal(await auth.verifySession('missing'), false);
  assert.equal(await auth.verifySession('expired'), false);
});

test('session cookie creation, deletion, LAN HTTP, and explicit HTTPS attributes', () => {
  assert.deepEqual(auth.getSessionCookieOptions({ isHttps: false }), { secure: false, sameSite: 'lax', maxAge: 86400, path: '/' });
  assert.deepEqual(auth.getSessionCookieOptions({ isHttps: true }), { secure: true, sameSite: 'lax', maxAge: 86400, path: '/' });
  assert.deepEqual(auth.getSessionCookieDeletionOptions({ isHttps: true }), { secure: true, sameSite: 'lax', maxAge: 0, path: '/' });
});

test('auth tests cannot modify the real authentication file', async () => {
  let before = null;
  try { before = await fs.readFile(realAuthPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeAuth('canary-secret');
  assert.equal(await auth.verifyApiKey('canary-secret'), true);
  let after = null;
  try { after = await fs.readFile(realAuthPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (before) assert.deepEqual(after, before);
  else assert.equal(after, null);
});
