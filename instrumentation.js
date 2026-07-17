function safeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    code: String(error?.code ?? ""),
    message: String(error?.message ?? error ?? "Unknown instrumentation error")
      .trim()
      .slice(0, 4000),
  };
}

async function registerForRuntime({
  runtime,
  logger = console,
  loadNodeInstrumentation,
} = {}) {
  if (runtime !== "nodejs") {
    return {
      status: "skipped",
      runtime: String(runtime ?? ""),
    };
  }

  if (typeof loadNodeInstrumentation !== "function") {
    throw new Error("Node instrumentation loader must be a function");
  }

  try {
    const nodeInstrumentation = await loadNodeInstrumentation();
    if (
      typeof nodeInstrumentation?.registerMqttNodeInstrumentation !== "function"
    ) {
      throw new Error(
        "Node instrumentation did not expose registerMqttNodeInstrumentation()"
      );
    }

    return await nodeInstrumentation.registerMqttNodeInstrumentation({ logger });
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

/**
 * Next.js invokes register() once for each server instance. Keep the literal
 * NEXT_RUNTIME guard around the Node-only import so the Edge compilation never
 * follows PostgreSQL or MQTT dependencies.
 */
export async function register() {
  const runtime = process.env.NEXT_RUNTIME;

  if (runtime === "nodejs") {
    return registerForRuntime({
      runtime,
      loadNodeInstrumentation: () => import("./instrumentation.node.js"),
    });
  }

  return registerForRuntime({ runtime });
}

export const mqttInstrumentationInternals = Object.freeze({
  safeError,
  registerForRuntime,
});
