import { getPool } from "./db.js";
import { VehicleDirectionRepository } from "./vehicle-direction-repository.mjs";
import { VehicleDirectionService } from "./vehicle-direction-service.mjs";
import { NotificationAcceptedReadService } from "./notification-accepted-read-service.mjs";
import { NotificationRuntimeRepository } from "./notification-runtime-repository.mjs";
import { MqttRepository } from "./mqtt/repository.mjs";
import { getConfig } from "./settings.js";
import { publishPlateReadChanges } from "./sse.js";

let service = null;
let directionNotificationService = null;

export async function getVehicleDirectionService() {
  if (!service) {
    const pool = await getPool();
    service = new VehicleDirectionService({
      repository: new VehicleDirectionRepository({ pool }),
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
      changeNotifier: ({ readId, reason }) => {
        publishPlateReadChanges([readId], reason);
      },
    });
  }
  return service;
}

