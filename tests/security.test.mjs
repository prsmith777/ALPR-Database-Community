import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { middleware } from "../middleware.js";
import { getSessionCookieOptions } from "../lib/cookies.js";

const REAL_AUTH_FILE = path.join(process.cwd(), "auth", "auth.json");

function makeRequest(pathname, { headers = {}, cookies = {} } = {}) {
  const url = new URL(pathname, "http://localhost:3000");
  const headerMap = new Headers(headers);
  return {
    method: "GET",
    url: url.toString(),
    nextUrl: { pathname: url.pathname, search: url.search },
    headers: headerMap,
    cookies: { get: (name) => cookies[name] ? { value: cookies[name] } : undefined },
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

async function withEnv(updates, fn) {
  const previous = {};
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key];
    if (updates[key] === undefined) delete process.env[key];
    else process.env[key] = updates[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withFetch(mock, fn) {
  const previousFetch = global.fetch;
  global.fetch = mock;
  try {
    return await fn();
  } finally {
    global.fetch = previousFetch;
  }
}

async function importFreshAuth() {
  return import(`../lib/auth.js?test=${Date.now()}-${Math.random()}`);
}

test("security suite does not alter an existing auth/auth.json canary", async () => {
  let before;
  try {
    before = await fs.readFile(REAL_AUTH_FILE, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  await middleware(makeRequest("/dashboard", {
    headers: { "x-forwarded-for": "127.0.0.1" },
  }));

  const after = await fs.readFile(REAL_AUTH_FILE, "utf8");
  assert.equal(after, before);
});

test("direct HTTP production leaves session cookies non-secure by default", async () => {
  await withEnv({ NODE_ENV: "production", SESSION_COOKIE_SECURE: undefined }, () => {
    assert.equal(getSessionCookieOptions().secure, false);
  });
});

test("SESSION_COOKIE_SECURE=true enables secure session cookies", async () => {
  await withEnv({ SESSION_COOKIE_SECURE: "true" }, () => {
    assert.equal(getSessionCookieOptions().secure, true);
  });
});

test("SESSION_COOKIE_SECURE=false disables secure session cookies", async () => {
  await withEnv({ SESSION_COOKIE_SECURE: "false" }, () => {
    assert.equal(getSessionCookieOptions().secure, false);
  });
});

test("session cookie creation and deletion share attributes", async () => {
  await withEnv({ SESSION_COOKIE_SECURE: "true" }, () => {
    const created = getSessionCookieOptions({ maxAge: 86400 });
    const deleted = getSessionCookieOptions({ maxAge: 0 });
    assert.equal(created.secure, deleted.secure);
    assert.equal(created.sameSite, deleted.sameSite);
    assert.equal(created.path, deleted.path);
  });
});

test("spoofed forwarded headers do not grant browser access without a session", async () => {
  await withFetch(async () => jsonResponse({ allowed: true }), async () => {
    const response = await middleware(makeRequest("/", {
      headers: { "x-forwarded-for": "192.168.1.10" },
    }));
    assert.equal(response.status, 307);
    assert.match(response.headers.get("location"), /\/login$/);
  });
});

test("spoofed forwarded headers do not grant API access without a session", async () => {
  await withFetch(async () => jsonResponse({ allowed: true }), async () => {
    const response = await middleware(makeRequest("/api/settings", {
      headers: { "x-forwarded-for": "192.168.1.10" },
    }));
    assert.equal(response.status, 307);
    assert.match(response.headers.get("location"), /\/login$/);
  });
});

test("valid sessions continue working", async () => {
  await withFetch(async (url) => {
    if (String(url).includes("/api/verify-session")) return jsonResponse({ valid: true });
    if (String(url).includes("/api/check-update")) return jsonResponse({ updateRequired: false });
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const response = await middleware(makeRequest("/", { cookies: { session: "valid" } }));
    assert.equal(response.status, 200);
  });
});

test("valid query api_key authentication continues working", async () => {
  await withFetch(async (url) => {
    assert.ok(String(url).includes("/api/verify-key"));
    return jsonResponse({ valid: true });
  }, async () => {
    const response = await middleware(makeRequest("/?api_key=secret"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-api-key"), "secret");
  });
});

test("valid Authorization Bearer authentication continues working for /api/plates", async () => {
  await withFetch(async (url) => {
    assert.ok(String(url).includes("/api/verify-key"));
    return jsonResponse({ valid: true });
  }, async () => {
    const response = await middleware(makeRequest("/api/plates", {
      headers: { Authorization: "Bearer secret" },
    }));
    assert.equal(response.status, 200);
  });
});

test("requireApiKey returns 401 for missing or invalid credentials and 503 for storage errors", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alpr-auth-test-"));
  try {
    await withEnv({ NODE_ENV: "test", ALPR_AUTH_FILE_PATH: path.join(tempDir, "auth.json") }, async () => {
      await fs.writeFile(path.join(tempDir, "auth.json"), JSON.stringify({ apiKey: "valid", sessions: {}, password: "hash" }));
      const { requireApiKey } = await importFreshAuth();
      assert.deepEqual(await requireApiKey(), { ok: false, status: 401, error: "API key is required" });
      assert.deepEqual(await requireApiKey("wrong"), { ok: false, status: 401, error: "Invalid API key" });
      assert.deepEqual(await requireApiKey("valid"), { ok: true, status: 200 });
    });

    await withEnv({ NODE_ENV: "test", ALPR_AUTH_FILE_PATH: path.join(tempDir, "missing", "auth.json"), ADMIN_PASSWORD: undefined }, async () => {
      const { requireApiKey } = await importFreshAuth();
      const result = await requireApiKey("anything");
      assert.equal(result.ok, false);
      assert.equal(result.status, 503);
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
