import { getPool } from "./db.js";
import { VehicleReidV2ShadowRepository } from "./vehicle-reid-v2-shadow-repository.mjs";
import { VehicleReidV2ShadowService } from "./vehicle-reid-v2-shadow.mjs";

let service = null;

export async function getVehicleReidV2ShadowService() {
  if (!service) {
    const pool = await getPool();
    service = new VehicleReidV2ShadowService({
      repository: new VehicleReidV2ShadowRepository({ pool }),
    });
  }
  return service;
}
