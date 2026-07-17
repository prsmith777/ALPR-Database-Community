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
