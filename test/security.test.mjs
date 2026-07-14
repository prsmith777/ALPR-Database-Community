import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  getSessionCookieOptions,
  getSessionCookieDeleteOptions,
  sanitizeUrlForLog,
} from "../lib/security.js";
import { getHeaderApiKey, hasQueryApiKey } from "../lib/authz.js";
import {
  initializeAuth,
  createSession,
  verifySession,
  verifyApiKey,
  __resetAuthCacheForTests,
} from "../lib/auth.js";

const originalEnv = { ...process.env };

test.afterEach(() => {
  process.env = { ...originalEnv };
  __resetAuthCacheForTests();
});

test("session cookie secure flag follows SESSION_COOKIE_SECURE while default preserves direct HTTP", () => {
  delete process.env.SESSION_COOKIE_SECURE;
  assert.equal(getSessionCookieOptions().secure, false);
  process.env.SESSION_COOKIE_SECURE = "true";
  assert.equal(getSessionCookieOptions().secure, true);
  process.env.SESSION_COOKIE_SECURE = "false";
  assert.equal(getSessionCookieOptions().secure, false);

  const deletion = getSessionCookieDeleteOptions();
  assert.equal(deletion.httpOnly, true);
  assert.equal(deletion.sameSite, "lax");
  assert.equal(deletion.path, "/");
  assert.equal(deletion.maxAge, 0);
  assert.equal(deletion.secure, false);
});

test("auth tests use isolated AUTH_FILE and do not touch auth/auth.json", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alpr-auth-"));
  process.env.AUTH_FILE = path.join(tempDir, "auth.json");
  process.env.ADMIN_PASSWORD = "test-password";

  const config = await initializeAuth();
  const sessionId = await createSession("test agent");

  assert.ok(config.apiKey);
  assert.equal(await verifySession(sessionId), true);
  assert.equal(await verifyApiKey(config.apiKey), true);
  await assert.rejects(
    fs.access(path.join(process.cwd(), "auth", "auth.json")),
  );
});

test("API key extraction supports x-api-key and bearer but rejects query-string API keys", () => {
  assert.equal(getHeaderApiKey(new Headers({ "x-api-key": "abc" })), "abc");
  assert.equal(
    getHeaderApiKey(new Headers({ authorization: "Bearer def" })),
    "def",
  );
  assert.equal(hasQueryApiKey("http://localhost/api/plates?api_key=abc"), true);
});

test("sensitive query strings are redacted before logging", () => {
  assert.equal(
    sanitizeUrlForLog("http://localhost/api/plates?api_key=secret&camera=1"),
    "/api/plates?api_key=%5BREDACTED%5D&camera=1",
  );
  assert.equal(
    sanitizeUrlForLog("http://localhost/path?sessionId=sid"),
    "/path?sessionId=%5BREDACTED%5D",
  );
});

function makeRequest(path, { headers = {}, cookie } = {}) {
  const url = new URL(path, "http://localhost");
  return {
    method: "GET",
    url: url.toString(),
    nextUrl: url,
    headers: new Headers(headers),
    cookies: {
      get: (name) =>
        name === "session" && cookie ? { value: cookie } : undefined,
    },
  };
}

test("middleware rejects query-string API keys without echoing secrets", async () => {
  const { middleware } = await import("../middleware.js");
  const response = await middleware(makeRequest("/api/plates?api_key=secret"));

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("x-api-key"), null);
  assert.equal(
    (await response.json()).error,
    "Query-string API keys are not accepted",
  );
});

test("middleware returns structured 503 for API authentication storage failures", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return Response.json({ valid: false }, { status: 503 });
  };
  try {
    const { middleware } = await import("../middleware.js");
    const response = await middleware(
      makeRequest("/api/plates", { headers: { "x-api-key": "secret" } }),
    );

    assert.equal(response.status, 503);
    assert.equal(
      (await response.json()).error,
      "Authentication service unavailable",
    );
    assert.equal(response.headers.get("x-api-key"), null);
    assert.equal(
      calls.some((url) => url.includes("/api/verify-key")),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("middleware fails closed for protected browser routes on session verification 5xx", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/verify-session")) {
      return Response.json({ valid: false }, { status: 503 });
    }
    throw new Error("unexpected fetch");
  };
  try {
    const { middleware } = await import("../middleware.js");
    const response = await middleware(
      makeRequest("/dashboard", { cookie: "session-secret" }),
    );

    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "http://localhost/login");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("middleware ignores spoofed X-Forwarded-For instead of granting whitelist access", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return Response.json({ allowed: true }, { status: 200 });
  };
  try {
    const { middleware } = await import("../middleware.js");
    const response = await middleware(
      makeRequest("/dashboard", {
        headers: { "x-forwarded-for": "127.0.0.1" },
      }),
    );

    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "http://localhost/login");
    assert.equal(
      calls.some((url) => url.includes("/api/verify-whitelist")),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
