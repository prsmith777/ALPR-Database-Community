import { getPool } from "./db.js";
import { VehicleReidV2AuthorityRepository } from "./vehicle-reid-v2-authority-repository.mjs";
import { VehicleReidV2AuthorityService } from "./vehicle-reid-v2-authority-service.mjs";

const RUNTIME_STATE = Symbol.for("alpr.vehicle-reid-v2-authority.runtime.v1");

function stateFor(host = globalThis) {
  if (!host[RUNTIME_STATE]) host[RUNTIME_STATE] = { servicePromise: null };
  return host[RUNTIME_STATE];
}

export async function getVehicleReidV2AuthorityService({
  stateHost = globalThis,
  poolLoader = getPool,
} = {}) {
  const state = stateFor(stateHost);
  if (!state.servicePromise) {
    state.servicePromise = (async () => {
      const pool = await poolLoader();
      return new VehicleReidV2AuthorityService({
        repository: new VehicleReidV2AuthorityRepository({ pool }),
      });
    })().catch((error) => {
      state.servicePromise = null;
      throw error;
    });
  }
  return state.servicePromise;
}

export const vehicleReidV2AuthorityRuntimeInternals = Object.freeze({
  RUNTIME_STATE,
  stateFor,
});
