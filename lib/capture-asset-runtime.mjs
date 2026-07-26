import { getPool } from "./db.js";
import fileStorage from "./fileStorage.js";
import { CaptureAssetRepository } from "./capture-asset-repository.mjs";
import { CaptureAssetService } from "./capture-asset-service.mjs";
import { NotificationAcceptedReadService } from "./notification-accepted-read-service.mjs";
import { NotificationRuntimeRepository } from "./notification-runtime-repository.mjs";
import { MqttRepository } from "./mqtt/repository.mjs";
import { getConfig } from "./settings.js";

let service = null;
let directionNotificationService = null;

export async function getCaptureAssetService() {
  if (!service) {
    const pool = await getPool();
    service = new CaptureAssetService({
      repository: new CaptureAssetRepository({ pool }),
      fileStorage,
      logger: console,
      directionNotifier: async ({ read, observation }) => {
        if (!directionNotificationService) {
          const config = await getConfig();
          directionNotificationService = new NotificationAcceptedReadService({
            repository: new NotificationRuntimeRepository({ executor: pool }),
            mqttRepository: new MqttRepository({ pool }),
            logger: console,
            matchingSettings: config.plateMatching,
          });
        }
        return directionNotificationService.processVehicleDirection(read, observation);
      },
    });
  }
  return service;
}
