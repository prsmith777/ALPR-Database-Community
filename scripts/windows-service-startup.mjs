import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

function connectionOptions(installation, timeoutMs) {
  const environment = installation.environment;
  const port = String(environment?.DB_HOST).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port || Number(port) < 1 || Number(port) > 65535 || environment.DB_USER !== "postgres" ||
      environment.DB_NAME !== "postgres" || typeof environment.DB_PASSWORD !== "string" || !environment.DB_PASSWORD) {
    throw new Error("Unsupported native startup database configuration");
  }
  return { host: "127.0.0.1", port: Number(port), user: "postgres", database: "postgres",
    password: environment.DB_PASSWORD, ssl: false, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs };
}

export async function probeWindowsDatabase(installation, application, { signal, timeoutMs, clientFactory } = {}) {
  signal?.throwIfAborted();
  const config = connectionOptions(installation, timeoutMs);
  if (!clientFactory) {
    // The fixed launcher has no node_modules. Use the selected release's pg
    // client, rather than resolving any dependency from a developer checkout.
    const { Client } = createRequire(path.join(application, "package.json"))("pg");
    clientFactory = (options) => new Client(options);
  }
  const client = clientFactory(config);
  client.on("error", () => {});
  const cancel = () => client.connection?.stream?.destroy();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    await client.connect();
    signal?.throwIfAborted();
    const result = await client.query("SELECT 1 AS ready");
    signal?.throwIfAborted();
    return result.rows?.[0]?.ready === 1;
  } catch {
    signal?.throwIfAborted();
    // Database diagnostics can contain connection details. Only the readiness
    // result reaches the service log; credentials never enter a command line.
    return false;
  } finally {
    try { await client.end(); } catch { /* a failed connection still needs cleanup */ }
    signal?.removeEventListener("abort", cancel);
  }
}

export async function waitForWindowsDatabase(installation, application, {
  signal, timeoutMs = 60_000, probeTimeoutMs = 3000, retryIntervalMs = 1000,
  probe = probeWindowsDatabase, now = () => performance.now(), pause = sleep, onWaiting = () => {},
} = {}) {
  if (![timeoutMs, probeTimeoutMs, retryIntervalMs].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("Invalid native startup readiness limits");
  }
  // Refuse a malformed configuration before treating failures as transient.
  connectionOptions(installation, probeTimeoutMs);
  const deadline = now() + timeoutMs;
  let announced = false;
  while (now() < deadline) {
    signal?.throwIfAborted();
    if (await probe(installation, application, { signal, timeoutMs: Math.max(1, Math.min(probeTimeoutMs, deadline - now())) })) {
      signal?.throwIfAborted();
      return;
    }
    signal?.throwIfAborted();
    if (!announced) { onWaiting(); announced = true; }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await pause(Math.min(retryIntervalMs, remaining), undefined, { signal });
  }
  throw new Error("PostgreSQL did not become ready within the startup timeout");
}
