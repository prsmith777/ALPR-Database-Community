import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';

test('/api/plate-reads authenticates before parsing and avoids sensitive logging', async () => {
  const source = await fs.readFile('app/api/plate-reads/route.js', 'utf8');
  assert(source.indexOf('authorizeApiRequest(req)') < source.indexOf('req.json()'));
  assert(source.includes('Received authenticated plate-read request'));
  assert(!source.includes('Received plate read data'));
  assert(!source.includes('details: error.message'));
});

test('/api/plate-reads supports both headers and rejects missing/invalid credentials through shared auth', async () => {
  const source = await fs.readFile('app/api/plate-reads/route.js', 'utf8');
  assert(source.includes('authorizeApiRequest'));
  assert(!source.includes('getAuthConfig'));
  assert(!source.includes('apiKey !=='));
});

test('middleware returns JSON 401/503 for protected API failures and rejects query API keys', async () => {
  const source = await fs.readFile('middleware.js', 'utf8');
  assert(source.includes('request.nextUrl.searchParams.has("api_key")'));
  assert(source.includes('return NextResponse.json({ error: "Unauthorized" }, { status: 401 });'));
  assert(source.includes('Authentication temporarily unavailable'));
});

test('middleware does not trust spoofed X-Forwarded-For for browser or API access', async () => {
  const source = await fs.readFile('middleware.js', 'utf8');
  assert(source.includes('/api/verify-whitelist'));
  assert(source.includes('authorizeApiKeyRequest(request)'));
  assert(!source.includes('x-forwarded-for') || source.includes('Object.fromEntries(request.headers)'));
});

test('session verification timeout, network failure, HTTP 5xx, and malformed response are fail closed', async () => {
  const source = await fs.readFile('middleware.js', 'utf8');
  assert(source.includes('Session verification timeout, redirecting to login.'));
  assert(source.includes('Network error during session verification, redirecting to login.'));
  assert(source.includes('Server error during session verification, redirecting to login.'));
  assert(source.includes('const result = await response.json();'));
});
