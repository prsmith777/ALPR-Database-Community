import test from "node:test";
import assert from "node:assert/strict";

import {
  authorizeIntegrationRequest,
  createIntegrationRouteHandler,
} from "../lib/request-auth.mjs";
import { timingSafeCompareSecrets } from "../lib/timing-safe-compare.mjs";

function makeRequest({
  url = "http://localhost/api/plate-reads",
  headers = {},
  body = {},
} = {}) {
  return {
    url,
    headers: new Headers(headers),
    json: async () => body,
  };
}

function verifierResponse(valid, status = 200) {
  return Response.json({ valid }, { status });
}

test("accepts a valid x-api-key credential", async () => {
  const result = await authorizeIntegrationRequest(
    makeRequest({ headers: { "x-api-key": "test-key" } }),
    { fetchImpl: async () => verifierResponse(true) }
  );
  assert.equal(result.ok, true);
});

test("accepts a valid Bearer credential", async () => {
  const result = await authorizeIntegrationRequest(
    makeRequest({ headers: { Authorization: "Bearer test-key" } }),
    { fetchImpl: async () => verifierResponse(true) }
  );
  assert.equal(result.ok, true);
});

test("API-key verification ignores attacker request metadata and uses only the trusted origin", async () => {
  const calls = [];
  const result = await authorizeIntegrationRequest(
    makeRequest({
      url: "http://attacker.example/api/plate-reads",
      headers: {
        "x-api-key": "credential-sentinel",
        Host: "host-attacker.example",
        "X-Forwarded-Host": "forwarded-attacker.example",
        "X-Forwarded-Proto": "https",
      },
    }),
    {
      env: {
        ALPR_INTERNAL_ORIGIN:
          "https://trusted-internal.example:8443/ignored/path",
      },
      fetchImpl: async (url, options) => {
        calls.push({ url: new URL(url), options });
        return verifierResponse(true);
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url.href,
    "https://trusted-internal.example:8443/api/verify-key"
  );
  assert.equal(calls[0].url.hostname.includes("attacker"), false);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    apiKey: "credential-sentinel",
  });
});

test("invalid internal origin fails closed before an API key can be sent", async () => {
  let fetchCalls = 0;
  const result = await authorizeIntegrationRequest(
    makeRequest({ headers: { "x-api-key": "credential-sentinel" } }),
    {
      env: { ALPR_INTERNAL_ORIGIN: "http://user@attacker.example" },
      fetchImpl: async () => {
        fetchCalls += 1;
        return verifierResponse(true);
      },
    }
  );

  assert.equal(result.status, 503);
  assert.equal(fetchCalls, 0);
});

test("rejects a missing API credential", async () => {
  let called = false;
  const result = await authorizeIntegrationRequest(makeRequest(), {
    fetchImpl: async () => {
      called = true;
      return verifierResponse(true);
    },
  });
  assert.equal(result.status, 401);
  assert.equal(called, false);
});

test("rejects an invalid API credential", async () => {
  const result = await authorizeIntegrationRequest(
    makeRequest({ headers: { "x-api-key": "invalid" } }),
    { fetchImpl: async () => verifierResponse(false, 401) }
  );
  assert.equal(result.status, 401);
});

test("rejects query-string API credentials even with a valid header", async () => {
  let called = false;
  const result = await authorizeIntegrationRequest(
    makeRequest({
      url: "http://localhost/api/plate-reads?api_key=query-secret",
      headers: { "x-api-key": "valid-header" },
    }),
    {
      fetchImpl: async () => {
        called = true;
        return verifierResponse(true);
      },
    }
  );
  assert.equal(result.status, 401);
  assert.equal(called, false);
});

test("maps verifier HTTP 4xx responses to 401", async () => {
  const result = await authorizeIntegrationRequest(
    makeRequest({ headers: { "x-api-key": "test-key" } }),
    { fetchImpl: async () => new Response(null, { status: 403 }) }
  );
  assert.equal(result.status, 401);
});

test("maps verifier HTTP 5xx responses to 503", async () => {
  const result = await authorizeIntegrationRequest(
    makeRequest({ headers: { "x-api-key": "test-key" } }),
    { fetchImpl: async () => new Response(null, { status: 500 }) }
  );
  assert.equal(result.status, 503);
});

test("maps verifier timeout failures to 503", async () => {
  const result = await authorizeIntegrationRequest(
    makeRequest({ headers: { "x-api-key": "test-key" } }),
    {
      fetchImpl: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    }
  );
  assert.equal(result.status, 503);
});

test("maps verifier network failures to 503", async () => {
  const result = await authorizeIntegrationRequest(
    makeRequest({ headers: { "x-api-key": "test-key" } }),
    {
      fetchImpl: async () => {
        throw new Error("network failed");
      },
    }
  );
  assert.equal(result.status, 503);
});

test("maps malformed verifier JSON to 503", async () => {
  const result = await authorizeIntegrationRequest(
    makeRequest({ headers: { "x-api-key": "test-key" } }),
    { fetchImpl: async () => new Response("not-json", { status: 200 }) }
  );
  assert.equal(result.status, 503);
});

test("maps a missing verifier valid field to 503", async () => {
  const result = await authorizeIntegrationRequest(
    makeRequest({ headers: { "x-api-key": "test-key" } }),
    { fetchImpl: async () => Response.json({}) }
  );
  assert.equal(result.status, 503);
});

test("maps a non-boolean verifier valid field to 503", async () => {
  const result = await authorizeIntegrationRequest(
    makeRequest({ headers: { "x-api-key": "test-key" } }),
    { fetchImpl: async () => Response.json({ valid: "true" }) }
  );
  assert.equal(result.status, 503);
});

test("maps HTTP 200 valid false to 401", async () => {
  const result = await authorizeIntegrationRequest(
    makeRequest({ headers: { "x-api-key": "test-key" } }),
    { fetchImpl: async () => verifierResponse(false) }
  );
  assert.equal(result.status, 401);
});

test("maps HTTP 200 valid true to success", async () => {
  const result = await authorizeIntegrationRequest(
    makeRequest({ headers: { "x-api-key": "test-key" } }),
    { fetchImpl: async () => verifierResponse(true) }
  );
  assert.equal(result.ok, true);
});

test("unequal secret byte lengths return false without throwing", () => {
  assert.doesNotThrow(() => timingSafeCompareSecrets("short", "much-longer"));
  assert.equal(timingSafeCompareSecrets("short", "much-longer"), false);
});

test("plate-read route wrapper authorizes before parsing JSON", async () => {
  const events = [];
  const receiptCalls = [];
  const handler = createIntegrationRouteHandler(
    async () => {
      events.push("process");
      return Response.json({ ok: true });
    },
    {
      authorize: async () => {
        events.push("authorize");
        return { ok: false, status: 401 };
      },
      recorder: {
        async start(details) {
          receiptCalls.push({ operation: "start", details });
          return 41;
        },
        async complete(details) {
          receiptCalls.push({ operation: "complete", details });
        },
      },
      logger: {
        info(event) {
          events.push(event);
        },
        warn(event) {
          events.push(event);
        },
        error() {},
      },
    }
  );
  const request = makeRequest();
  request.json = async () => {
    events.push("json");
    return {};
  };

  const response = await handler(request);
  assert.equal(response.status, 401);
  assert.deepEqual(events, [
    "integration_request_arrived",
    "authorize",
    "integration_request_rejected",
  ]);
  assert.equal(receiptCalls.length, 2);
  assert.equal(receiptCalls[0].operation, "start");
  assert.equal(receiptCalls[0].details.rawText, null);
  assert.equal(receiptCalls[0].details.data, null);
  assert.equal(receiptCalls[1].operation, "complete");
  assert.equal(receiptCalls[1].details.httpStatus, 401);
  assert.equal(receiptCalls[1].details.errorCode, "UNAUTHORIZED");
});

test("plate-read wrapper logs no secrets, payloads, paths, or raw failures", async () => {
  const output = [];
  const logger = {
    log: (...values) => output.push(values.join(" ")),
    error: (...values) => output.push(values.join(" ")),
  };
  const handler = createIntegrationRouteHandler(
    async () => {
      throw new Error("raw-exception-sentinel C:\\private\\auth.json");
    },
    {
      authorize: async () => ({ ok: true, status: 200 }),
      logger,
    }
  );
  const request = makeRequest({
    url: "http://localhost/api/plate-reads?api_key=query-key-sentinel",
    headers: {
      Authorization: "Bearer bearer-token-sentinel",
      "x-api-key": "api-key-sentinel",
    },
    body: {
      plate_number: "FULL-PLATE-PAYLOAD",
      Image: "IMAGE-DATA-SENTINEL",
      ai_dump: "AI-DUMP-SENTINEL",
      sessionId: "SESSION-ID-SENTINEL",
    },
  });

  const response = await handler(request);
  const captured = output.join(" ");
  assert.equal(response.status, 500);
  for (const secret of [
    "bearer-token-sentinel",
    "api-key-sentinel",
    "query-key-sentinel",
    "FULL-PLATE-PAYLOAD",
    "IMAGE-DATA-SENTINEL",
    "AI-DUMP-SENTINEL",
    "SESSION-ID-SENTINEL",
    "raw-exception-sentinel",
    "C:\\private\\auth.json",
  ]) {
    assert.equal(captured.includes(secret), false);
  }
});

test("integration wrapper correlates a successful request with its receipt", async () => {
  const receiptCalls = [];
  const logCalls = [];
  const recorder = {
    async start(details) {
      receiptCalls.push({ operation: "start", details });
      return {
        receiptId: 73,
        logSummary: {
          cameraName: "Street LPR 1",
          triggerField: "trigger_type",
          triggerPresent: true,
          triggerValueState: "recorded",
          triggerType: "MOTION_A>B",
        },
      };
    },
    async complete(details) {
      receiptCalls.push({ operation: "complete", details });
    },
  };
  const handler = createIntegrationRouteHandler(
    async (data, _request, context) => {
      assert.equal(data.camera, "Street LPR 1");
      assert.equal(context.requestId, "blue-iris-request-73");
      context.setOutcome({
        outcome: "accepted",
        processedReadIds: [901],
        processedCount: 1,
      });
      return Response.json({ ok: true }, { status: 201 });
    },
    {
      authorize: async () => ({ ok: true, status: 200 }),
      recorder,
      integration: "blue_iris",
      routeName: "/api/plate-reads",
      logger: {
        info(event, details) { logCalls.push({ event, details }); },
        warn() {},
        error() {},
      },
    }
  );
  const rawBody = JSON.stringify({
    camera: "Street LPR 1",
    trigger_type: "MOTION_A>B",
  });
  const response = await handler(new Request("http://localhost/api/plate-reads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "blue-iris-request-73",
    },
    body: rawBody,
  }));

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-request-id"), "blue-iris-request-73");
  assert.equal(receiptCalls.length, 2);
  assert.equal(receiptCalls[0].operation, "start");
  assert.equal(receiptCalls[0].details.rawText, rawBody);
  assert.equal(receiptCalls[0].details.bodyBytes, Buffer.byteLength(rawBody));
  assert.deepEqual(receiptCalls[0].details.data, JSON.parse(rawBody));
  assert.equal(receiptCalls[1].operation, "complete");
  assert.equal(receiptCalls[1].details.receiptId, 73);
  assert.equal(receiptCalls[1].details.httpStatus, 201);
  assert.equal(receiptCalls[1].details.outcome, "accepted");
  assert.deepEqual(receiptCalls[1].details.processedReadIds, [901]);
  assert.deepEqual(
    logCalls.find(({ event }) => event === "integration_request_received")?.details,
    {
      requestId: "blue-iris-request-73",
      integration: "blue_iris",
      routeName: "/api/plate-reads",
      cameraName: "Street LPR 1",
      triggerField: "trigger_type",
      triggerPresent: true,
      triggerValueState: "recorded",
      triggerType: "MOTION_A>B",
    }
  );
});

test("integration wrapper accepts Blue Iris JSON sent as text/plain", async () => {
  const events = [];
  const logEvents = [];
  const logLevels = [];
  const recorder = {
    async start(details) {
      events.push({ operation: "start", details });
      return 88;
    },
    async complete(details) {
      events.push({ operation: "complete", details });
    },
  };
  const handler = createIntegrationRouteHandler(
    async (data) => {
      assert.equal(data.camera, "Driveway LPR");
      return Response.json({ ok: true }, { status: 201 });
    },
    {
      authorize: async () => ({ ok: true, status: 200 }),
      recorder,
      maxBodyBytes: 1024,
      integration: "blue_iris",
      logger: {
        info(event) {
          logEvents.push(event);
          logLevels.push({ event, level: "info" });
        },
        warn(event) {
          logEvents.push(event);
          logLevels.push({ event, level: "warn" });
        },
        error() {},
      },
    }
  );

  const rawBody = JSON.stringify({ camera: "Driveway LPR" });
  const response = await handler(new Request("http://localhost/api/plate-reads", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: rawBody,
  }));

  assert.equal(response.status, 201);
  assert.deepEqual(logEvents, [
    "integration_request_arrived",
    "integration_content_type_compatibility",
    "integration_request_received",
  ]);
  assert.deepEqual(
    logLevels.find((entry) => entry.event === "integration_content_type_compatibility"),
    { event: "integration_content_type_compatibility", level: "info" }
  );
  assert.equal(events[0].details.contentType, "text/plain");
  assert.equal(events[0].details.rawText, rawBody);
  assert.deepEqual(events[0].details.data, { camera: "Driveway LPR" });
  assert.equal(events[1].details.httpStatus, 201);
});

test("integration wrapper rejects oversized bodies with receipts", async () => {
  const events = [];
  const recorder = {
    async start(details) {
      events.push({ operation: "start", details });
      return 88;
    },
    async complete(details) {
      events.push({ operation: "complete", details });
    },
  };
  const handler = createIntegrationRouteHandler(
    async () => assert.fail("rejected requests must not reach the processor"),
    {
      authorize: async () => ({ ok: true, status: 200 }),
      recorder,
      maxBodyBytes: 16,
      logger: { info() {}, warn() {}, error() {} },
    }
  );

  const oversized = await handler(makeRequest({
    headers: {
      "content-type": "application/json",
      "content-length": "17",
    },
  }));
  assert.equal(oversized.status, 413);
  assert.equal(events[0].details.bodyBytes, 17);
  assert.equal(events[1].details.errorCode, "BODY_TOO_LARGE");
});
