import { getPool } from "./db.js";
import fileStorage from "./fileStorage.js";
import { CaptureAssetRepository } from "./capture-asset-repository.mjs";
import { CaptureAssetService } from "./capture-asset-service.mjs";

let service = null;

export async function getCaptureAssetService() {
  if (!service) {
    service = new CaptureAssetService({
      repository: new CaptureAssetRepository({ pool: await getPool() }),
      fileStorage,
      logger: console,
    });
  }
  return service;
}
