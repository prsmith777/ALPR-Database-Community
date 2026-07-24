export async function registerMqttNodeInstrumentation({
  logger = console,
  loadStartup = () => import("./lib/mqtt/startup.mjs"),
} = {}) {
  if (typeof loadStartup !== "function") {
    throw new Error("MQTT startup loader must be a function");
  }

  const startup = await loadStartup();
  if (typeof startup?.startMqttRuntimeWithRetry !== "function") {
    throw new Error("MQTT startup module did not expose startMqttRuntimeWithRetry()");
  }

  return startup.startMqttRuntimeWithRetry({ logger });
}

export async function registerNodeInstrumentation({
  logger = console,
  startMqtt = (options) => registerMqttNodeInstrumentation(options),
  loadVisualStartup = () => import("./lib/visual-index-startup.mjs"),
} = {}) {
  if (typeof startMqtt !== "function" || typeof loadVisualStartup !== "function") {
    throw new Error("Node instrumentation loaders must be functions");
  }
  const [mqttResult, visualResult] = await Promise.allSettled([
    startMqtt({ logger }),
    (async () => {
      const visualStartup = await loadVisualStartup();
      if (typeof visualStartup?.startVisualIndexRuntimeWithRetry !== "function") {
        throw new Error("Visual index startup module did not expose startVisualIndexRuntimeWithRetry()");
      }
      return visualStartup.startVisualIndexRuntimeWithRetry({ logger });
    })(),
  ]);
  const normalizeResult = (result, name) => {
    if (result.status === "fulfilled") return result.value;
    const error = {
      name: String(result.reason?.name || "Error"),
      code: String(result.reason?.code || ""),
      message: String(result.reason?.message || result.reason || `${name} startup failed`)
        .trim()
        .slice(0, 1000),
    };
    logger?.error?.(`${name} instrumentation startup failed`, { error });
    return { status: "error", error };
  };
  const mqtt = normalizeResult(mqttResult, "MQTT");
  const visualIndex = normalizeResult(visualResult, "Visual index");
  return {
    status: mqtt.status === "started" && visualIndex.status === "started"
      ? "started"
      : "partial",
    mqtt,
    visualIndex,
  };
}
