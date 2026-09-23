import { getPool } from "./db.js";
import { VehicleReidV2ConversionRepository } from "./vehicle-reid-v2-conversion-repository.mjs";
import { VehicleReidV2ConversionService } from "./vehicle-reid-v2-conversion-service.mjs";
import { getVehicleReidV2ShadowService } from "./vehicle-reid-v2-shadow-runtime.mjs";

let service = null;

export async function getVehicleReidV2ConversionService() {
  if (!service) {
    const [pool, shadowService] = await Promise.all([
      getPool(),
      getVehicleReidV2ShadowService(),
    ]);
    service = new VehicleReidV2ConversionService({
      repository: new VehicleReidV2ConversionRepository({ pool }),
      shadowService,
    });
  }
  return service;
}
