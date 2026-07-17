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
 * Next.js invokes register() once for each server instance. The literal
 * NEXT_RUNTIME condition must directly surround the dynamic import so the Edge
 * compiler removes the Node-only PostgreSQL and MQTT dependency graph.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const nodeInstrumentation = await import("./instrumentation.node.js");
      return await nodeInstrumentation.registerMqttNodeInstrumentation({
        logger: console,
      });
    } catch (error) {
      const normalized = safeError(error);
      console.error("MQTT instrumentation registration failed", {
        error: normalized,
      });
      return {
        status: "error",
        runtime: "nodejs",
        error: normalized,
      };
    }
  }

  return {
    status: "skipped",
    runtime: String(process.env.NEXT_RUNTIME ?? ""),
  };
}

export const mqttInstrumentationInternals = Object.freeze({
  safeError,
  registerForRuntime,
});
