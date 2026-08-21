import { getPool } from "./db.js";
import { createComponentLogger } from "../logging/logger.js";
import { VehicleReidV2ShadowRepository } from "./vehicle-reid-v2-shadow-repository.mjs";
import { VehicleReidV2ShadowService } from "./vehicle-reid-v2-shadow.mjs";

let service = null;
const primarySearchLogger = createComponentLogger("vehicle-reid-v2-primary-search");

export async function getVehicleReidV2ShadowService() {
  if (!service) {
    const pool = await getPool();
    service = new VehicleReidV2ShadowService({
      repository: new VehicleReidV2ShadowRepository({ pool }),
      logger: primarySearchLogger,
    });
  }
  return service;
}
