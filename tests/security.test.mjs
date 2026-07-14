import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { NextRequest } from "next/server.js";
import { middleware } from "../middleware.js";
import { resetAuthCacheForTests } from "../lib/auth.js";
import {
  extractApiKey,
  getSessionCookieOptions,
  redactUrlForLog,
} from "../lib/security.js";

const AUTH_PATH = new URL("../auth/auth.json", import.meta.url);
const now = Date.now();

async function writeAuth(sessionOverrides = {}) {
  await fs.mkdir(new URL("../auth/", import.meta.url), { recursive: true });
  await fs.writeFile(
    AUTH_PATH,
    JSON.stringify({
      password: "$2b$10$placeholderplaceholderplaceholderplaceholderplaceh",
      apiKey: "header-secret",
      sessions: {
        valid: {
          id: "valid",
          userAgent: "test",
          createdAt: now,
          lastUsed: now,
          expiresAt: now + 60_000,
          ...sessionOverrides.valid,
        },
        expired: {
          id: "expired",
          userAgent: "test",
          createdAt: now - 120_000,
          lastUsed: now - 120_000,
          expiresAt: now - 60_000,
          ...sessionOverrides.expired,
        },
      },
    })
  );
}


function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function installFetchMock() {
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/check-update") return jsonResponse({ updateRequired: false });
    if (parsed.pathname === "/api/verify-whitelist") return jsonResponse({ allowed: false });
    if (parsed.pathname === "/api/verify-key") {
      const headers = new Headers(options.headers);
      const authorization = headers.get("authorization");
      const key = headers.get("x-api-key") || (authorization?.startsWith("Bearer ") ? authorization.slice(7) : null);
      return key === "header-secret" ? jsonResponse({ valid: true }) : jsonResponse({ valid: false }, { status: 401 });
    }
    if (parsed.pathname === "/api/verify-session") {
      if (parsed.searchParams.get("case") === "network") throw new Error("network");
      if (parsed.searchParams.get("case") === "timeout") throw new DOMException("timeout", "AbortError");
      if (parsed.searchParams.get("case") === "5xx") return jsonResponse({ valid: false }, { status: 500 });
      if (parsed.searchParams.get("case") === "malformed") return new Response("not-json", { status: 200 });
      const { sessionId } = JSON.parse(options.body || "{}");
      if (sessionId === "valid") return jsonResponse({ valid: true });
      return jsonResponse({ valid: false });
    }
    throw new Error(`unexpected fetch ${parsed.pathname}`);
  };
}

function req(path, { cookie, headers = {} } = {}) {
  const request = new NextRequest(`http://localhost${path}`, { headers });
  if (cookie) request.cookies.set("session", cookie);
  return request;
}

test.beforeEach(async () => {
  process.env.NODE_ENV = "test";
  process.env.ALLOW_INSECURE_DEV_COOKIES = "true";
  await writeAuth();
  resetAuthCacheForTests();
  installFetchMock();
});

test("valid session allows protected browser access", async () => {
  const response = await middleware(req("/", { cookie: "valid" }));
  assert.equal(response.status, 200);
});

test("missing session redirects browser clients to login", async () => {
  const response = await middleware(req("/"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/login");
});

test("invalid session redirects and clears the session cookie", async () => {
  const response = await middleware(req("/", { cookie: "bogus" }));
  assert.equal(response.status, 307);
  assert.match(response.headers.get("set-cookie"), /session=;/);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
});

test("expired session is rejected", async () => {
  const response = await middleware(req("/", { cookie: "expired" }));
  assert.equal(response.status, 307);
  assert.match(response.headers.get("set-cookie"), /session=;/);
});

test("protected API routes return JSON instead of an HTML redirect", async () => {
  const response = await middleware(req("/api/private", { cookie: "bogus" }));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("authenticated user visiting login is redirected home", async () => {
  const response = await middleware(req("/login", { cookie: "valid" }));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/");
});

test("session verification dependency failure fails closed with 503 for APIs", async () => {
  global.fetch = async () => jsonResponse({ valid: false }, { status: 500 });
  const response = await middleware(req("/api/private", { cookie: "valid" }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Authentication temporarily unavailable" });
});

test("session verification dependency failure fails closed with 503 for browser pages", async () => {
  global.fetch = async () => jsonResponse({ valid: false }, { status: 500 });
  const response = await middleware(req("/", { cookie: "valid" }));
  assert.equal(response.status, 503);
});

test("session-verification timeout/network/5xx/malformed failure modes are not fail-open", async () => {
  const failures = [
    async () => { throw new DOMException("timeout", "AbortError"); },
    async () => { throw new Error("network"); },
    async () => jsonResponse({ valid: false }, { status: 500 }),
    async () => new Response("not-json", { status: 200 }),
  ];
  for (const failure of failures) {
    global.fetch = failure;
    const response = await middleware(req("/api/private", { cookie: "valid" }));
    assert.equal(response.status, 503);
  }
});

test("query-string API keys are rejected", async () => {
  const response = await middleware(req("/api/plate-reads?api_key=header-secret"));
  assert.equal(response.status, 401);
});

test("x-api-key continues to work", async () => {
  const response = await middleware(req("/api/plate-reads", { headers: { "x-api-key": "header-secret" } }));
  assert.equal(response.status, 200);
});

test("Authorization bearer API key continues to work", async () => {
  const response = await middleware(req("/api/plate-reads", { headers: { authorization: "Bearer header-secret" } }));
  assert.equal(response.status, 200);
});

test("sensitive URL query values are not included in request log output", () => {
  const url = new URL("http://localhost/api/plate-reads?api_key=secret");
  assert.equal(redactUrlForLog(url), "/api/plate-reads");
});

test("session cookies contain required security attributes", () => {
  const options = getSessionCookieOptions();
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/");
  assert.equal(options.maxAge, 86400);
  assert.equal(options.secure, false);

  process.env.NODE_ENV = "production";
  delete process.env.ALLOW_INSECURE_DEV_COOKIES;
  assert.equal(getSessionCookieOptions().secure, true);
});

test("API-key extractor supports only headers", () => {
  assert.deepEqual(extractApiKey(req("/api/plate-reads?api_key=secret")), { rejectedQueryApiKey: true });
  assert.deepEqual(extractApiKey(req("/api/plate-reads", { headers: { "x-api-key": "secret" } })), { apiKey: "secret" });
  assert.deepEqual(extractApiKey(req("/api/plate-reads", { headers: { authorization: "Bearer secret" } })), { apiKey: "secret" });
});
