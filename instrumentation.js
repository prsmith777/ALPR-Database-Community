function safeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    code: String(error?.code ?? ""),
    message: String(error?.message ?? error ?? "Unknown instrumentation error")
      .trim()
      .slice(0, 4000),
  };
}

/**
 * Next.js invokes register() once for each server instance. MQTT is Node-only,
 * so Edge initialization exits without importing PostgreSQL or mqtt packages.
 */
export async function register({
  runtime = process.env.NEXT_RUNTIME,
  logger = console,
  loadStartup = () => import("./lib/mqtt/startup.mjs"),
} = {}) {
  if (runtime !== "nodejs") {
    return {
      status: "skipped",
      runtime: String(runtime ?? ""),
    };
  }

  try {
    const startup = await loadStartup();
    if (typeof startup?.startMqttRuntimeWithRetry !== "function") {
      throw new Error("MQTT startup module did not expose startMqttRuntimeWithRetry()");
    }

    return await startup.startMqttRuntimeWithRetry({ logger });
  } catch (error) {
    const normalized = safeError(error);
    logger?.error?.("MQTT instrumentation registration failed", {
      error: normalized,
    });

    return {
      status: "error",
      runtime: "nodejs",
      error: normalized,
    };
  }
}

export const mqttInstrumentationInternals = Object.freeze({
  safeError,
});
