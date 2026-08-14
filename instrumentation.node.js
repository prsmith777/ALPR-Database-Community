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
  loadVehicleFrameStartup = () => import("./lib/blue-iris-vehicle-frame-startup.mjs"),
  loadNotificationStartup = () => import("./lib/notification-operations-startup.mjs"),
  loadMaintenanceStartup = () => import("./lib/maintenance-startup.mjs"),
  loadStorageMonitorStartup = () => import("./lib/storage-maintenance-monitor-startup.mjs"),
  loadVehicleAssetCatalogStartup = () => import("./lib/vehicle-image-asset-catalog-startup.mjs"),
} = {}) {
  if (typeof startMqtt !== "function" || typeof loadVisualStartup !== "function" || typeof loadVehicleFrameStartup !== "function" || typeof loadNotificationStartup !== "function" || typeof loadMaintenanceStartup !== "function" || typeof loadStorageMonitorStartup !== "function" || typeof loadVehicleAssetCatalogStartup !== "function") {
    throw new Error("Node instrumentation loaders must be functions");
  }
  const [mqttResult, visualResult, vehicleFrameResult, notificationResult, maintenanceResult, storageMonitorResult, vehicleAssetCatalogResult] = await Promise.allSettled([
    startMqtt({ logger }),
    (async () => {
      const visualStartup = await loadVisualStartup();
      if (typeof visualStartup?.startVisualIndexRuntimeWithRetry !== "function") {
        throw new Error("Visual index startup module did not expose startVisualIndexRuntimeWithRetry()");
      }
      return visualStartup.startVisualIndexRuntimeWithRetry({ logger });
    })(),
    (async () => {
      const startup = await loadVehicleFrameStartup();
      if (typeof startup?.startBlueIrisVehicleFrameRuntimeWithRetry !== "function") {
        throw new Error("Blue Iris vehicle-frame startup module did not expose startBlueIrisVehicleFrameRuntimeWithRetry()");
      }
      return startup.startBlueIrisVehicleFrameRuntimeWithRetry({ logger });
    })(),
    (async () => {
      const startup = await loadNotificationStartup();
      if (typeof startup?.startNotificationOperationsRuntimeWithRetry !== "function") {
        throw new Error("Notification operations startup module did not expose startNotificationOperationsRuntimeWithRetry()");
      }
      return startup.startNotificationOperationsRuntimeWithRetry({ logger });
    })(),
    (async () => {
      const startup = await loadMaintenanceStartup();
      if (typeof startup?.startMaintenanceRuntimeWithRetry !== "function") {
        throw new Error("Maintenance startup module did not expose startMaintenanceRuntimeWithRetry()");
      }
      return startup.startMaintenanceRuntimeWithRetry({ logger });
    })(),
    (async () => {
      const startup = await loadStorageMonitorStartup();
      if (typeof startup?.startStorageMaintenanceMonitorWithRetry !== "function") {
        throw new Error("Storage maintenance monitor startup module did not expose startStorageMaintenanceMonitorWithRetry()");
      }
      return startup.startStorageMaintenanceMonitorWithRetry({ logger });
    })(),
    (async () => {
      const startup = await loadVehicleAssetCatalogStartup();
      if (typeof startup?.startVehicleImageAssetCatalogRuntimeWithRetry !== "function") {
        throw new Error("Canonical Overview catalog startup module did not expose startVehicleImageAssetCatalogRuntimeWithRetry()");
      }
      return startup.startVehicleImageAssetCatalogRuntimeWithRetry({ logger });
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
  const vehicleFrames = normalizeResult(vehicleFrameResult, "Blue Iris vehicle frames");
  const notificationOperations = normalizeResult(notificationResult, "Notification operations");
  const maintenance = normalizeResult(maintenanceResult, "Maintenance");
  const storageMonitor = normalizeResult(storageMonitorResult, "Storage maintenance monitor");
  const vehicleAssetCatalog = normalizeResult(vehicleAssetCatalogResult, "Canonical Overview catalog");
  return {
    status: mqtt.status === "started" && visualIndex.status === "started" && vehicleFrames.status === "started" && notificationOperations.status === "started" && maintenance.status === "started" && storageMonitor.status === "started" && vehicleAssetCatalog.status === "started"
      ? "started"
      : "partial",
    mqtt,
    visualIndex,
    vehicleFrames,
    notificationOperations,
    maintenance,
    storageMonitor,
    vehicleAssetCatalog,
  };
}
