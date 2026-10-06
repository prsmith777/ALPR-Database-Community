import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { probeWindowsDatabase, waitForWindowsDatabase } from "../scripts/windows-service-startup.mjs";

const installation = { environment: { DB_HOST: "127.0.0.1:5433", DB_USER: "postgres",
  DB_NAME: "postgres", DB_PASSWORD: "private fixture password" } };

test("a ready database starts immediately without any initial delay", async () => {
  let calls = 0;
  await waitForWindowsDatabase(installation, "unused", {
    probe: async () => { calls++; return true; },
    pause: () => { throw new Error("A ready database must not sleep"); },
  });
  assert.equal(calls, 1);
});

test("database startup retries only failed checks and announces waiting once", async () => {
  let clock = 0, calls = 0, announcements = 0;
  const pauses = [];
  await waitForWindowsDatabase(installation, "unused", {
    now: () => clock, probe: async () => ++calls === 3,
    pause: async (ms) => { pauses.push(ms); clock += ms; }, onWaiting: () => announcements++,
  });
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [1000, 1000]);
  assert.equal(announcements, 1);
});

test("a failed check is limited by the remaining startup budget", async () => {
  let clock = 0;
  const limits = [];
  await assert.rejects(waitForWindowsDatabase(installation, "unused", {
    timeoutMs: 2500, now: () => clock,
    probe: async (_installation, _application, { timeoutMs }) => { limits.push(timeoutMs); clock += timeoutMs; return false; },
    pause: () => { throw new Error("The exhausted deadline must not sleep"); },
  }), /did not become ready/);
  assert.deepEqual(limits, [2500]);
});

test("service stop cancels waiting and prevents another database attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(waitForWindowsDatabase(installation, "unused", {
    signal: controller.signal, probe: async () => { calls++; return false; },
    pause: async (_ms, _value, { signal }) => { controller.abort(); signal.throwIfAborted(); },
  }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("readiness uses the protected credentials for an authenticated read-only query", async () => {
  const operations = [];
  const ready = await probeWindowsDatabase(installation, "unused", { timeoutMs: 3000,
    clientFactory: (options) => {
      assert.equal(options.host, "127.0.0.1");
      assert.equal(options.port, 5433);
      assert.equal(options.password, installation.environment.DB_PASSWORD);
      assert.equal(options.connectionTimeoutMillis, 3000);
      assert.equal(options.query_timeout, 3000);
      return { on() {}, async connect() { operations.push("connect"); },
        async query(sql) { operations.push(sql); return { rows: [{ ready: 1 }] }; },
        async end() { operations.push("end"); } };
    },
  });
  assert.equal(ready, true);
  assert.deepEqual(operations, ["connect", "SELECT 1 AS ready", "end"]);
});

test("failed authentication closes the client and does not expose connection diagnostics", async () => {
  let closed = false;
  assert.equal(await probeWindowsDatabase(installation, "unused", { timeoutMs: 3000,
    clientFactory: () => ({ on() {}, async connect() { throw new Error(installation.environment.DB_PASSWORD); },
      async end() { closed = true; } }),
  }), false);
  assert.equal(closed, true);
});

test("service stop aborts an in-flight database connection and closes its client", async () => {
  const controller = new AbortController();
  let rejectConnection, closed = false;
  const attempt = probeWindowsDatabase(installation, "unused", { timeoutMs: 3000, signal: controller.signal,
    clientFactory: () => ({ on() {}, connection: { stream: { destroy() { rejectConnection(new Error("Stopped")); } } },
      connect() { return new Promise((_resolve, reject) => { rejectConnection = reject; }); },
      async end() { closed = true; } }),
  });
  controller.abort();
  await assert.rejects(attempt, { name: "AbortError" });
  assert.equal(closed, true);
});

test("startup refuses remote databases and malformed readiness limits", async () => {
  await assert.rejects(waitForWindowsDatabase({ environment: { ...installation.environment, DB_HOST: "example.invalid:5433" } }, "unused"), /Unsupported native/);
  await assert.rejects(waitForWindowsDatabase(installation, "unused", { retryIntervalMs: 0 }), /Invalid native/);
});

test("new installs use normal automatic startup while retaining the database dependency", async () => {
  const source = await readFile(new URL("../scripts/windows/Install.ps1", import.meta.url), "utf8");
  assert.match(source, /<depend>ALPRCommunityDatabase<\/depend><startmode>Automatic<\/startmode>/);
  assert.doesNotMatch(source, /<delayedAutoStart[\s>\/]/);
});
