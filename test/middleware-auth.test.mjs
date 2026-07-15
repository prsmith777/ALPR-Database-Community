import test from "node:test";
import assert from "node:assert/strict";

import { createMiddlewareHandler } from "../lib/middleware-auth.mjs";

const VALID_SESSION_ID = "a".repeat(64);
const INVALID_SESSION_ID = "b".repeat(64);
const EXPIRED_SESSION_ID = "c".repeat(64);
const UNVERIFIED_SESSION_ID = "d".repeat(64);

function makeResponse(type, details = {}) {
  const cookieWrites = [];
  return {
    type,
    ...details,
    cookieWrites,
    cookies: {
      set: (name, value, options) =>
        cookieWrites.push({ name, value, options }),
    },
  };
}

function responseAdapters(fetchImpl) {
  return {
    fetchImpl,
    next: () => makeResponse("next", { status: 200 }),
    redirect: (url) =>
      makeResponse("redirect", { status: 307, location: url.pathname }),
    json: (body, init) =>
      makeResponse("json", { status: init.status, body }),
  };
}

function makeRequest(
  pathname,
  { sessionId, headers = {}, origin = "http://localhost" } = {}
) {
  const url = new URL(pathname, origin);
  return {
    url: url.href,
    nextUrl: url,
    headers: new Headers(headers),
    cookies: {
      get: (name) =>
        name === "session" && sessionId ? { value: sessionId } : undefined,
    },
  };
}

function sessionFetch(valid = true) {
  return async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/verify-session") {
      return Response.json({ valid });
    }
    return Response.json({ updateRequired: false });
  };
}

test("protected browser page redirects when the session is missing", async () => {
  const handler = createMiddlewareHandler(responseAdapters(sessionFetch()));
  const response = await handler(makeRequest("/dashboard"));
  assert.equal(response.type, "redirect");
  assert.equal(response.location, "/login");
});

test("protected browser page allows a valid session", async () => {
  const handler = createMiddlewareHandler(responseAdapters(sessionFetch(true)));
  const response = await handler(
    makeRequest("/dashboard", { sessionId: VALID_SESSION_ID })
  );
  assert.equal(response.type, "next");
});

test("invalid browser session redirects and clears the cookie", async () => {
  const handler = createMiddlewareHandler(responseAdapters(sessionFetch(false)));
  const response = await handler(
    makeRequest("/dashboard", { sessionId: INVALID_SESSION_ID })
  );
  assert.equal(response.location, "/login");
  assert.equal(response.cookieWrites.length, 1);
  assert.equal(response.cookieWrites[0].options.maxAge, 0);
});

test("expired browser session redirects and clears the cookie", async () => {
  const handler = createMiddlewareHandler(responseAdapters(sessionFetch(false)));
  const response = await handler(
    makeRequest("/dashboard", { sessionId: EXPIRED_SESSION_ID })
  );
  assert.equal(response.location, "/login");
  assert.equal(response.cookieWrites[0].value, "");
});

for (const [name, fetchImpl] of [
  ["timeout", async () => { throw new DOMException("timeout", "TimeoutError"); }],
  ["network failure", async () => { throw new Error("network"); }],
  ["HTTP 5xx", async () => new Response(null, { status: 503 })],
  ["malformed JSON", async () => new Response("bad", { status: 200 })],
  ["missing valid", async () => Response.json({})],
  ["non-boolean valid", async () => Response.json({ valid: 1 })],
]) {
  test(`protected browser page fails closed on verifier ${name}`, async () => {
    const handler = createMiddlewareHandler(responseAdapters(fetchImpl));
    const response = await handler(
      makeRequest("/dashboard", { sessionId: UNVERIFIED_SESSION_ID })
    );
    assert.equal(response.type, "redirect");
    assert.equal(response.location, "/login");
  });
}

test("login remains accessible without a session", async () => {
  const handler = createMiddlewareHandler(responseAdapters(sessionFetch()));
  const response = await handler(makeRequest("/login"));
  assert.equal(response.type, "next");
});

test("login redirects a valid session to the home page", async () => {
  const handler = createMiddlewareHandler(responseAdapters(sessionFetch(true)));
  const response = await handler(
    makeRequest("/login", { sessionId: VALID_SESSION_ID })
  );
  assert.equal(response.type, "redirect");
  assert.equal(response.location, "/");
});

test("login clears an invalid session and remains accessible", async () => {
  const handler = createMiddlewareHandler(responseAdapters(sessionFetch(false)));
  const response = await handler(
    makeRequest("/login", { sessionId: INVALID_SESSION_ID })
  );
  assert.equal(response.type, "next");
  assert.equal(response.cookieWrites.length, 1);
});

test("login remains accessible during a temporary verifier failure", async () => {
  const handler = createMiddlewareHandler(
    responseAdapters(async () => new Response(null, { status: 500 }))
  );
  const response = await handler(
    makeRequest("/login", { sessionId: UNVERIFIED_SESSION_ID })
  );
  assert.equal(response.type, "next");
  assert.equal(response.cookieWrites.length, 0);
});

test("application API returns JSON 401 for a missing session", async () => {
  const handler = createMiddlewareHandler(responseAdapters(sessionFetch()));
  const response = await handler(makeRequest("/api/chat"));
  assert.equal(response.type, "json");
  assert.equal(response.status, 401);
});

test("application API allows a valid browser session", async () => {
  const handler = createMiddlewareHandler(responseAdapters(sessionFetch(true)));
  const response = await handler(
    makeRequest("/api/chat", { sessionId: VALID_SESSION_ID })
  );
  assert.equal(response.type, "next");
});

test("application API returns JSON 401 and clears an invalid session", async () => {
  const handler = createMiddlewareHandler(responseAdapters(sessionFetch(false)));
  const response = await handler(
    makeRequest("/api/chat", { sessionId: INVALID_SESSION_ID })
  );
  assert.equal(response.type, "json");
  assert.equal(response.status, 401);
  assert.equal(response.cookieWrites.length, 1);
});

test("application API returns JSON 503 for temporary verification failure", async () => {
  const handler = createMiddlewareHandler(
    responseAdapters(async () => new Response(null, { status: 500 }))
  );
  const response = await handler(
    makeRequest("/api/chat", { sessionId: UNVERIFIED_SESSION_ID })
  );
  assert.equal(response.type, "json");
  assert.equal(response.status, 503);
  assert.equal(response.cookieWrites.length, 0);
});

test("update page redirects to login when the session is missing", async () => {
  const handler = createMiddlewareHandler(responseAdapters(sessionFetch()));
  const response = await handler(makeRequest("/update"));

  assert.equal(response.type, "redirect");
  assert.equal(response.location, "/login");
});

test("update page clears an invalid session and redirects to login", async () => {
  const handler = createMiddlewareHandler(responseAdapters(sessionFetch(false)));
  const response = await handler(
    makeRequest("/update", { sessionId: INVALID_SESSION_ID })
  );

  assert.equal(response.type, "redirect");
  assert.equal(response.location, "/login");
  assert.equal(response.cookieWrites.length, 1);
  assert.equal(response.cookieWrites[0].value, "");
});

test("valid session can access update page without an update redirect loop", async () => {
  const calls = [];
  const handler = createMiddlewareHandler(
    responseAdapters(async (url) => {
      calls.push(new URL(url).pathname);
      return Response.json({ valid: true });
    })
  );
  const response = await handler(
    makeRequest("/update", { sessionId: VALID_SESSION_ID })
  );

  assert.equal(response.type, "next");
  assert.deepEqual(calls, ["/api/verify-session"]);
});

test("update page fails closed on temporary session verification failure", async () => {
  const handler = createMiddlewareHandler(
    responseAdapters(async () => new Response(null, { status: 503 }))
  );
  const response = await handler(
    makeRequest("/update", { sessionId: UNVERIFIED_SESSION_ID })
  );

  assert.equal(response.type, "redirect");
  assert.equal(response.location, "/login");
  assert.equal(response.cookieWrites.length, 0);
});

test("another protected page redirects to update when an update is required", async () => {
  const calls = [];
  const handler = createMiddlewareHandler(
    responseAdapters(async (url) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      if (pathname === "/api/verify-session") {
        return Response.json({ valid: true });
      }
      return Response.json({ updateRequired: true });
    })
  );
  const response = await handler(
    makeRequest("/dashboard", { sessionId: VALID_SESSION_ID })
  );

  assert.equal(response.type, "redirect");
  assert.equal(response.location, "/update");
  assert.deepEqual(calls, ["/api/verify-session", "/api/check-update"]);
});

test("spoofed X-Forwarded-For never grants access", async () => {
  let called = false;
  const handler = createMiddlewareHandler(
    responseAdapters(async () => {
      called = true;
      return Response.json({ allowed: true });
    })
  );
  const response = await handler(
    makeRequest("/dashboard", {
      headers: { "X-Forwarded-For": "127.0.0.1" },
    })
  );
  assert.equal(response.location, "/login");
  assert.equal(called, false);
});

test("session verification calls only verify-session with narrow headers", async () => {
  const calls = [];
  const handler = createMiddlewareHandler(
    responseAdapters(async (url, options) => {
      calls.push({ url: new URL(url), options });
      return Response.json({ valid: true });
    })
  );
  await handler(
    makeRequest("/api/chat", {
      sessionId: VALID_SESSION_ID,
      headers: {
        Authorization: "Bearer client-controlled",
        "X-Forwarded-For": "127.0.0.1",
        "X-Client-Secret": "must-not-forward",
      },
    })
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/api/verify-session");
  assert.deepEqual(calls[0].options.headers, {
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sessionId: VALID_SESSION_ID,
  });
});

test("session verification ignores attacker origins and forwarding headers", async () => {
  const calls = [];
  const handler = createMiddlewareHandler({
    ...responseAdapters(async (url, options) => {
      calls.push({ url: new URL(url), options });
      return Response.json({ valid: true });
    }),
    env: { ALPR_INTERNAL_ORIGIN: "https://trusted-internal.example/base" },
  });

  const response = await handler(
    makeRequest("/api/chat", {
      origin: "http://attacker.example",
      sessionId: VALID_SESSION_ID,
      headers: {
        Host: "host-attacker.example",
        "X-Forwarded-Host": "forwarded-attacker.example",
        "X-Forwarded-Proto": "https",
      },
    })
  );

  assert.equal(response.type, "next");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url.href,
    "https://trusted-internal.example/api/verify-session"
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sessionId: VALID_SESSION_ID,
  });
});

test("update checks use only the trusted internal origin", async () => {
  const calls = [];
  const handler = createMiddlewareHandler({
    ...responseAdapters(async (url) => {
      const parsedUrl = new URL(url);
      calls.push(parsedUrl);
      if (parsedUrl.pathname === "/api/verify-session") {
        return Response.json({ valid: true });
      }
      return Response.json({ updateRequired: false });
    }),
    env: { ALPR_INTERNAL_ORIGIN: "http://127.0.0.1:4567" },
  });

  const response = await handler(
    makeRequest("/dashboard", {
      origin: "http://attacker.example",
      sessionId: VALID_SESSION_ID,
      headers: {
        Host: "host-attacker.example",
        "X-Forwarded-Host": "forwarded-attacker.example",
        "X-Forwarded-Proto": "https",
      },
    })
  );

  assert.equal(response.type, "next");
  assert.deepEqual(
    calls.map((url) => url.href),
    [
      "http://127.0.0.1:4567/api/verify-session",
      "http://127.0.0.1:4567/api/check-update",
    ]
  );
});

test("invalid internal origin fails session verification closed without fetching", async () => {
  let fetchCalls = 0;
  const handler = createMiddlewareHandler({
    ...responseAdapters(async () => {
      fetchCalls += 1;
      return Response.json({ valid: true });
    }),
    env: { ALPR_INTERNAL_ORIGIN: "https://internal.example?redirect=attacker" },
  });

  const response = await handler(
    makeRequest("/api/chat", { sessionId: VALID_SESSION_ID })
  );

  assert.equal(response.type, "json");
  assert.equal(response.status, 503);
  assert.equal(fetchCalls, 0);
});

test("prototype-name session cookie cannot authorize a page or API", async () => {
  let verifierCalls = 0;
  const handler = createMiddlewareHandler(
    responseAdapters(async () => {
      verifierCalls += 1;
      return Response.json({ valid: true });
    })
  );

  const pageResponse = await handler(
    makeRequest("/dashboard", { sessionId: "__proto__" })
  );
  const apiResponse = await handler(
    makeRequest("/api/chat", { sessionId: "__proto__" })
  );

  assert.equal(pageResponse.type, "redirect");
  assert.equal(pageResponse.location, "/login");
  assert.equal(pageResponse.cookieWrites.length, 1);
  assert.equal(apiResponse.type, "json");
  assert.equal(apiResponse.status, 401);
  assert.equal(apiResponse.cookieWrites.length, 1);
  assert.equal(verifierCalls, 0);
});

test("login and update assets plus established public endpoints remain public", async () => {
  let verifierCalls = 0;
  const handler = createMiddlewareHandler(
    responseAdapters(async () => {
      verifierCalls += 1;
      return Response.json({ valid: true });
    })
  );

  for (const pathname of [
    "/grid.svg",
    "/1024.png",
    "/splash_screens/iPhone_16_Pro_Max_portrait.png",
    "/manifest.webmanifest",
    "/api/check-update",
    "/api/health-check",
    "/api/verify-key",
    "/api/verify-session",
  ]) {
    const response = await handler(makeRequest(pathname));
    assert.equal(response.type, "next", pathname);
  }

  assert.equal(verifierCalls, 0);
});

test("integration API paths use API-key authentication", async () => {
  const calls = [];
  const handler = createMiddlewareHandler(
    responseAdapters(async (url, options) => {
      calls.push({ url: new URL(url), options });
      return Response.json({ valid: true });
    })
  );
  const response = await handler(
    makeRequest("/api/plates/known", {
      headers: { "x-api-key": "integration-key" },
    })
  );
  assert.equal(response.type, "next");
  assert.equal(calls[0].url.pathname, "/api/verify-key");
});
