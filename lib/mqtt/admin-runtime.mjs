import { getPool } from "../db.js";
import { MqttAdminRepository } from "./admin-repository.mjs";

export async function getMqttAdminRepository() {
  const pool = await getPool();
  return new MqttAdminRepository({ pool });
}
