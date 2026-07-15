import test from "node:test";
import assert from "node:assert/strict";

import { createChatRouteHandler } from "../lib/chat-route.mjs";

const SESSION_ID = "a".repeat(64);

function validSession() {
  const now = Date.now();
  return {
    createdAt: now - 1000,
    lastUsed: now - 500,
    expiresAt: now + 60_000,
  };
}

function makeConfig() {
  const sessions = Object.create(null);
  sessions[SESSION_ID] = validSession();
  return { sessions };
}

function makeRequest(body, events = []) {
  return {
    json: async () => {
      events.push("json");
      return body;
    },
  };
}

function makeHarness(overrides = {}) {
  const logs = [];
  const config = overrides.config || makeConfig();
  const logger = {
    log: (...values) => logs.push(values.join(" ")),
    warn: (...values) => logs.push(values.join(" ")),
    error: (...values) => logs.push(values.join(" ")),
  };
  const dependencies = {
    readSessionId: async () => SESSION_ID,
    verifySession: async () => true,
    getAgents: async () => [
      {
        id: "agent-1",
        enabled: true,
        title: "Test Agent",
        url: "https://agent.invalid/webhook",
      },
    ],
    getAuthConfig: async () => config,
    updateAuthConfig: async () => {},
    fetchImpl: async () =>
      Response.json({ agentMessage: "Hello", structuredData: null }),
    logger,
    ...overrides,
  };
  delete dependencies.config;
  return {
    handler: createChatRouteHandler(dependencies),
    logs,
    config,
  };
}

test("missing session is rejected before request JSON parsing", async () => {
  const events = [];
  const { handler } = makeHarness({
    readSessionId: async () => {
      events.push("cookie");
      return null;
    },
    verifySession: async () => {
      events.push("verify");
      return true;
    },
  });

  const response = await handler(makeRequest({}, events));
  assert.equal(response.status, 401);
  assert.deepEqual(events, ["cookie"]);
});

test("invalid session is rejected before request JSON parsing", async () => {
  const events = [];
  const { handler } = makeHarness({
    readSessionId: async () => {
      events.push("cookie");
      return SESSION_ID;
    },
    verifySession: async () => {
      events.push("verify");
      return false;
    },
  });

  const response = await handler(makeRequest({}, events));
  assert.equal(response.status, 401);
  assert.deepEqual(events, ["cookie", "verify"]);
});

test("authentication storage failure returns generic 503 before parsing", async () => {
  const events = [];
  const sentinel = "AUTH_STORAGE_SECRET_SENTINEL";
  const { handler, logs } = makeHarness({
    verifySession: async () => {
      throw new Error(sentinel);
    },
  });

  const response = await handler(makeRequest({}, events));
  const body = await response.text();
  assert.equal(response.status, 503);
  assert.deepEqual(events, []);
  assert.equal(logs.join(" ").includes(sentinel), false);
  assert.equal(body.includes(sentinel), false);
  assert.deepEqual(JSON.parse(body), {
    error: "Authentication service unavailable",
  });
});

test("failed agent response body is neither logged nor returned", async () => {
  const sentinel = "FAILED_AGENT_BODY_SECRET_SENTINEL";
  const { handler, logs } = makeHarness({
    fetchImpl: async () => new Response(sentinel, { status: 502 }),
  });

  const response = await handler(
    makeRequest({ message: "hello", agentId: "agent-1" })
  );
  const body = await response.text();
  assert.equal(response.status, 500);
  assert.equal(logs.join(" ").includes(sentinel), false);
  assert.equal(body.includes(sentinel), false);
  assert.deepEqual(JSON.parse(body), {
    error: "Remote agent request failed",
    status: 502,
  });
});

test("thrown processing exception is neither logged nor returned", async () => {
  const sentinel = "THROWN_NETWORK_SECRET_SENTINEL";
  const { handler, logs } = makeHarness({
    fetchImpl: async () => {
      throw new Error(sentinel);
    },
  });

  const response = await handler(
    makeRequest({ message: "hello", agentId: "agent-1" })
  );
  const body = await response.text();
  assert.equal(response.status, 500);
  assert.equal(logs.join(" ").includes(sentinel), false);
  assert.equal(body.includes(sentinel), false);
  assert.deepEqual(JSON.parse(body), {
    error: "Unable to process chat request",
  });
});

test("client validation responses remain generic", async () => {
  const { handler } = makeHarness();
  const missingMessage = await handler(makeRequest({ agentId: "agent-1" }));
  const missingAgent = await handler(makeRequest({ message: "hello" }));
  const unknownAgent = await handler(
    makeRequest({ message: "hello", agentId: "secret-agent-id" })
  );

  assert.deepEqual(await missingMessage.json(), { error: "Message is required" });
  assert.deepEqual(await missingAgent.json(), { error: "Agent ID is required" });
  const unknownBody = await unknownAgent.text();
  assert.equal(unknownAgent.status, 404);
  assert.equal(unknownBody.includes("secret-agent-id"), false);
  assert.deepEqual(JSON.parse(unknownBody), {
    error: "Agent not found or disabled",
  });
});

test("successful chat preserves timezone, structured data, and agent session", async () => {
  const config = makeConfig();
  config.sessions[SESSION_ID]["agent-1_sessionId"] = "old-agent-session";
  let outbound;
  let updates = 0;
  const { handler } = makeHarness({
    config,
    fetchImpl: async (url, options) => {
      outbound = { url, options };
      return new Response(
        JSON.stringify({
          agentMessage: "It is morning",
          structuredData: { type: "metrics", value: 1 },
        }),
        {
          status: 200,
          headers: { "x-session-id": "new-agent-session" },
        }
      );
    },
    updateAuthConfig: async () => {
      updates += 1;
    },
  });

  const response = await handler(
    makeRequest({
      message: "What time is it?",
      timezone: "America/Denver",
      agentId: "agent-1",
    })
  );
  const body = await response.json();
  const payload = JSON.parse(outbound.options.body);

  assert.equal(response.status, 200);
  assert.equal(outbound.url, "https://agent.invalid/webhook");
  assert.equal(payload.chatInput, "What time is it?");
  assert.equal(payload.timezone, "America/Denver");
  assert.equal(payload.sessionId, "old-agent-session");
  assert.equal(body.response, "It is morning");
  assert.deepEqual(body.structured, { type: "metrics", value: 1 });
  assert.equal(
    config.sessions[SESSION_ID]["agent-1_sessionId"],
    "new-agent-session"
  );
  assert.equal(updates, 1);
});
