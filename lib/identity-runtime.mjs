import { getPool } from "./db.js";
import { PostgresIdentityRepository } from "./identity-repository.mjs";
import { IdentityService } from "./identity-service.mjs";

let identityService;

export function getIdentityService() {
  if (!identityService) {
    identityService = new IdentityService({
      repository: new PostgresIdentityRepository({ getPool }),
    });
  }
  return identityService;
}

export function setIdentityServiceForTests(service) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Identity service injection is only available during tests.");
  }
  identityService = service;
}
