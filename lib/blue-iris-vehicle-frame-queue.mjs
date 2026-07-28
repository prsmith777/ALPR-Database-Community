import { BlueIrisClient } from "./blue-iris.mjs";
import { BlueIrisVehicleFrameService } from "./blue-iris-vehicle-frame.mjs";

function normalizedCameraKey(value) {
  return String(value || "").trim().toLowerCase();
}

function blueIrisConfigured(config) {
  const settings = config?.blueiris || {};
  const host = String(settings.host || "").trim();
  return Boolean(
    host
    && !/your blue iris hostname/i.test(host)
    && String(settings.username || "").trim()
    && String(settings.password || "").trim()
  );
}

export class BlueIrisVehicleFrameQueue {
  constructor({
    repository,
    fileStorage,
    loadConfig,
    clientFactory = (settings) => new BlueIrisClient(settings),
    serviceFactory = (options) => new BlueIrisVehicleFrameService(options),
    logger = console,
  } = {}) {
    if (!repository || !fileStorage || typeof loadConfig !== "function") {
      throw new Error("Blue Iris vehicle-frame queue dependencies are required");
    }
    this.repository = repository;
    this.fileStorage = fileStorage;
    this.loadConfig = loadConfig;
    this.clientFactory = clientFactory;
    this.serviceFactory = serviceFactory;
    this.logger = logger;
    this.cameraCache = null;
    this.cameraCacheAt = 0;
    this.batchRunning = false;
  }

  async getStatus() {
    const [config, queue] = await Promise.all([
      this.loadConfig(),
      this.repository.getQueueStatus(),
    ]);
    return { ...queue, configured: blueIrisConfigured(config) };
  }

  async loadCameras(client, { force = false } = {}) {
    const now = Date.now();
    if (!force && this.cameraCache && now - this.cameraCacheAt < 5 * 60_000) {
      return this.cameraCache;
    }
    const connection = await client.testConnection();
    const cameras = new Map();
    for (const camera of connection.cameras || []) {
      const record = { id: camera.id, name: camera.name || camera.id };
      cameras.set(normalizedCameraKey(camera.id), record);
      cameras.set(normalizedCameraKey(camera.name), record);
    }
    this.cameraCache = cameras;
    this.cameraCacheAt = now;
    return cameras;
  }

  async processBatch({ limit = 1 } = {}) {
    if (this.batchRunning) return { busy: true, processed: 0, succeeded: 0, failed: 0 };
    this.batchRunning = true;
    try {
      const config = await this.loadConfig();
      if (!blueIrisConfigured(config)) {
        return { configured: false, processed: 0, succeeded: 0, failed: 0 };
      }
      const status = await this.repository.getQueueStatus();
      const client = this.clientFactory(config.blueiris);
      const cameras = await this.loadCameras(client);
      const service = this.serviceFactory({
        client,
        repository: this.repository,
        fileStorage: this.fileStorage,
      });
      const boundedLimit = Math.min(5, Math.max(1, Number.parseInt(String(limit), 10) || 1));
      const results = [];
      for (let index = 0; index < boundedLimit; index += 1) {
        const read = await this.repository.claimNext({
          includeHistorical: status.historicalPaused !== true,
        });
        if (!read) break;
        const camera = cameras.get(normalizedCameraKey(read.camera_name));
        if (!camera) {
          await this.repository.markFailed(read.id, {
            status: "unavailable",
            errorCode: "CAMERA_NOT_MAPPED",
            retryable: false,
          });
          results.push({ status: "unavailable", readId: Number(read.id), errorCode: "CAMERA_NOT_MAPPED" });
          continue;
        }
        results.push(await service.processRead({
          read,
          camera: camera.id,
          alreadyClaimed: true,
        }));
      }
      const succeeded = results.filter((result) => result.status === "ready").length;
      return {
        configured: true,
        processed: results.length,
        succeeded,
        failed: results.length - succeeded,
        results,
      };
    } catch (error) {
      this.cameraCache = null;
      this.logger?.error?.("Blue Iris vehicle-frame batch failed", {
        code: String(error?.code || ""),
        message: String(error?.message || error),
      });
      throw error;
    } finally {
      this.batchRunning = false;
    }
  }

  async queueHistorical(input = {}) {
    return this.repository.queueHistorical(input);
  }

  async setHistoricalPaused(paused) {
    return this.repository.setHistoricalPaused(paused === true);
  }
}

export const blueIrisVehicleFrameQueueInternals = Object.freeze({
  blueIrisConfigured,
  normalizedCameraKey,
});
