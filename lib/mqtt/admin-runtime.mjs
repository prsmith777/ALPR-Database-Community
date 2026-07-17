import { getPool } from "../db.js";
import { MqttAdminRepository } from "./admin-repository.mjs";
import { MqttRuleAdminRepository } from "./rule-admin-repository.mjs";

export async function getMqttAdminRepository() {
  const pool = await getPool();
  return new MqttAdminRepository({ pool });
}

export async function getMqttRuleAdminRepository() {
  const pool = await getPool();
  return new MqttRuleAdminRepository({ pool });
}
