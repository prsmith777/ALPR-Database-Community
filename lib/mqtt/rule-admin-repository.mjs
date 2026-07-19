import { PLATE_MATCH_MODES } from "../plate-matching.mjs";
import { validatePublishTopic } from "./topic-template.mjs";

const MATCH_TYPES = new Set([
  "any_plate",
  "exact_plate",
  "any_known_plate",
  "known_name",
  "tag",
]);
const DESTINATION_MODES = new Set(["per_camera", "fixed_topic"]);
const PLATE_MATCH_MODE_SET = new Set(PLATE_MATCH_MODES);

function ensurePool(pool) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new Error("MqttRuleAdminRepository requires a PostgreSQL-compatible pool");
  }
  return pool;
}

function requireText(value, name, maximumLength = 255) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} cannot be empty`);
  if (text.length > maximumLength) {
    throw new Error(`${name} cannot exceed ${maximumLength} characters`);
  }
  return text;
}

function optionalText(value, maximumLength = 255) {
  const text = String(value ?? "").trim();
  if (text.length > maximumLength) {
    throw new Error(`Value cannot exceed ${maximumLength} characters`);
  }
  return text;
}

function normalizeId(value, name = "MQTT rule ID") {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeInteger(value, { name, minimum, maximum, fallback }) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  if (value === 1) return true;
  if (value === 0) return false;
  throw new Error("MQTT boolean value must be true or false");
}

function normalizePlateMatchMode(input = {}) {
  const supplied = input.plateMatchMode ?? input.plate_match_mode;
  if (supplied === undefined || supplied === null || supplied === "") {
    return normalizeBoolean(
      input.fuzzyEnabled ?? input.fuzzy_enabled,
      false
    )
      ? "balanced"
      : "off";
  }

  const mode = String(supplied).trim().toLowerCase();
  if (!PLATE_MATCH_MODE_SET.has(mode)) {
    throw new Error(`Unsupported MQTT plate match mode: ${mode}`);
  }
  return mode;
}

function normalizeCameraIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("MQTT rule camera IDs must be an array");
  }

  const ids = value.map((item) => normalizeId(item, "MQTT camera ID"));
  return [...new Set(ids)].sort((left, right) => left - right);
}

function normalizeRuleInput(input = {}) {
  const matchType = requireText(
    input.matchType ?? input.match_type,
    "MQTT rule match type",
    50
  );
  if (!MATCH_TYPES.has(matchType)) {
    throw new Error(`Unsupported MQTT rule match type: ${matchType}`);
  }

  const destinationMode = requireText(
    input.destinationMode ?? input.destination_mode ?? "per_camera",
    "MQTT rule destination mode",
    50
  );
  if (!DESTINATION_MODES.has(destinationMode)) {
    throw new Error(`Unsupported MQTT destination mode: ${destinationMode}`);
  }

  const matchValue = optionalText(input.matchValue ?? input.match_value, 255);
  if (!["any_plate", "any_known_plate"].includes(matchType) && !matchValue) {
    throw new Error(`MQTT ${matchType} rules require a match value`);
  }

  const fixedTopic = optionalText(input.fixedTopic ?? input.fixed_topic, 65535);
  if (destinationMode === "fixed_topic") {
    validatePublishTopic(fixedTopic);
  }

  return {
    name: requireText(input.name, "MQTT rule name", 255),
    enabled: normalizeBoolean(input.enabled, true),
    matchType,
    matchValue:
      matchType === "any_plate" || matchType === "any_known_plate"
        ? ""
        : matchValue,
    plateMatchMode:
      matchType === "any_plate" ? "off" : normalizePlateMatchMode(input),
    fuzzyEnabled: normalizeBoolean(
      input.fuzzyEnabled ?? input.fuzzy_enabled,
      false
    ),
    fuzzyMaxDistance: normalizeInteger(
      input.fuzzyMaxDistance ?? input.fuzzy_max_distance,
      {
        name: "MQTT fuzzy maximum distance",
        minimum: 0,
        maximum: 2,
        fallback: 1,
      }
    ),
    fuzzyMinLength: normalizeInteger(
      input.fuzzyMinLength ?? input.fuzzy_min_length,
      {
        name: "MQTT fuzzy minimum length",
        minimum: 1,
        maximum: 20,
        fallback: 5,
      }
    ),
    fuzzyRequireUnique: normalizeBoolean(
      input.fuzzyRequireUnique ?? input.fuzzy_require_unique,
      true
    ),
    fuzzyOcrAware: normalizeBoolean(
      input.fuzzyOcrAware ?? input.fuzzy_ocr_aware,
      true
    ),
    brokerId: normalizeId(
      input.brokerId ?? input.broker_id,
      "MQTT broker ID"
    ),
    destinationMode,
    fixedTopic: destinationMode === "fixed_topic" ? fixedTopic : "",
    message: optionalText(input.message, 4000),
    cameraIds: normalizeCameraIds(input.cameraIds ?? input.camera_ids),
  };
}

function mapRule(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    enabled: Boolean(row.enabled),
    matchType: row.match_type,
    matchValue: row.match_value ?? "",
    plateMatchMode:
      row.plate_match_mode ||
      (Boolean(row.fuzzy_enabled) ? "balanced" : "off"),
    fuzzyEnabled: Boolean(row.fuzzy_enabled),
    fuzzyMaxDistance: Number(row.fuzzy_max_distance),
    fuzzyMinLength: Number(row.fuzzy_min_length),
    fuzzyRequireUnique: Boolean(row.fuzzy_require_unique),
    fuzzyOcrAware: Boolean(row.fuzzy_ocr_aware),
    brokerId: Number(row.broker_id),
    brokerName: row.broker_name ?? "",
    brokerEnabled: Boolean(row.broker_enabled),
    destinationMode: row.destination_mode,
    fixedTopic: row.fixed_topic ?? "",
    message: row.message ?? "",
    cameraIds: Array.isArray(row.camera_ids)
      ? row.camera_ids.map(Number).filter(Number.isInteger)
      : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOptions({ brokers, cameras, knownPlates, knownNames, tags }) {
  return {
    brokers: brokers.map((row) => ({
      id: Number(row.id),
      name: row.name,
      enabled: Boolean(row.enabled),
    })),
    cameras: cameras.map((row) => ({
      id: Number(row.id),
      cameraName: row.camera_name,
      cameraKey: row.camera_key,
      enabled: Boolean(row.enabled),
    })),
    knownPlates: knownPlates.map((row) => ({
      plateNumber: row.plate_number,
      name: row.name ?? "",
      tags: Array.isArray(row.tags) ? row.tags.filter(Boolean) : [],
    })),
    knownNames: knownNames.map((row) => row.name),
    tags: tags.map((row) => row.name),
  };
}

async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function selectRule(executor, id = null) {
  const result = await executor.query(
    `
      SELECT
        r.*,
        b.name AS broker_name,
        b.enabled AS broker_enabled,
        COALESCE(
          array_agg(rc.camera_id ORDER BY rc.camera_id)
            FILTER (WHERE rc.camera_id IS NOT NULL),
          ARRAY[]::integer[]
        ) AS camera_ids
      FROM public.mqtt_rules r
      JOIN public.mqttbrokers b ON b.id = r.broker_id
      LEFT JOIN public.mqtt_rule_cameras rc ON rc.rule_id = r.id
      WHERE ($1::integer IS NULL OR r.id = $1)
      GROUP BY r.id, b.id
      ORDER BY r.name, r.id
    `,
    [id]
  );
  return result.rows.map(mapRule);
}

async function replaceCameraLinks(executor, ruleId, cameraIds) {
  await executor.query(
    `DELETE FROM public.mqtt_rule_cameras WHERE rule_id = $1`,
    [ruleId]
  );

  if (cameraIds.length === 0) return;

  await executor.query(
    `
      INSERT INTO public.mqtt_rule_cameras (rule_id, camera_id)
      SELECT $1, camera_id
      FROM unnest($2::integer[]) AS camera_id
    `,
    [ruleId, cameraIds]
  );
}

export class MqttRuleAdminRepository {
  constructor({ pool } = {}) {
    this.pool = ensurePool(pool);
  }

  async listRules() {
    return selectRule(this.pool);
  }

  async getRule(id) {
    const ruleId = normalizeId(id);
    const rules = await selectRule(this.pool, ruleId);
    return rules[0] ?? null;
  }

  async listOptions() {
    const [brokers, cameras, knownPlates, knownNames, tags] = await Promise.all([
      this.pool.query(`
        SELECT id, name, enabled
        FROM public.mqttbrokers
        ORDER BY name, id
      `),
      this.pool.query(`
        SELECT id, camera_name, camera_key, enabled
        FROM public.mqtt_cameras
        ORDER BY camera_name, id
      `),
      this.pool.query(`
        SELECT
          kp.plate_number,
          kp.name,
          COALESCE(
            array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL),
            ARRAY[]::varchar[]
          ) AS tags
        FROM public.known_plates kp
        LEFT JOIN public.plate_tags pt ON pt.plate_number = kp.plate_number
        LEFT JOIN public.tags t ON t.id = pt.tag_id
        WHERE kp.ignore = FALSE
        GROUP BY kp.plate_number, kp.name
        ORDER BY kp.plate_number
      `),
      this.pool.query(`
        SELECT DISTINCT BTRIM(name) AS name
        FROM public.known_plates
        WHERE ignore = FALSE
          AND NULLIF(BTRIM(name), '') IS NOT NULL
        ORDER BY name
      `),
      this.pool.query(`
        SELECT name
        FROM public.tags
        ORDER BY name
      `),
    ]);

    return mapOptions({
      brokers: brokers.rows,
      cameras: cameras.rows,
      knownPlates: knownPlates.rows,
      knownNames: knownNames.rows,
      tags: tags.rows,
    });
  }

  async createRule(input) {
    const rule = normalizeRuleInput(input);

    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query(
        `
          INSERT INTO public.mqtt_rules (
            name,
            enabled,
            match_type,
            match_value,
            plate_match_mode,
            fuzzy_enabled,
            fuzzy_max_distance,
            fuzzy_min_length,
            fuzzy_require_unique,
            fuzzy_ocr_aware,
            broker_id,
            destination_mode,
            fixed_topic,
            message
          )
          VALUES (
            $1, $2, $3, NULLIF($4, ''), $5, $6, $7, $8,
            $9, $10, $11, $12, NULLIF($13, ''), NULLIF($14, '')
          )
          RETURNING id
        `,
        [
          rule.name,
          rule.enabled,
          rule.matchType,
          rule.matchValue,
          rule.plateMatchMode,
          rule.fuzzyEnabled,
          rule.fuzzyMaxDistance,
          rule.fuzzyMinLength,
          rule.fuzzyRequireUnique,
          rule.fuzzyOcrAware,
          rule.brokerId,
          rule.destinationMode,
          rule.fixedTopic,
          rule.message,
        ]
      );

      const ruleId = Number(inserted.rows[0].id);
      await replaceCameraLinks(client, ruleId, rule.cameraIds);
      const rules = await selectRule(client, ruleId);
      return rules[0];
    });
  }

  async updateRule(id, input) {
    const ruleId = normalizeId(id);
    const rule = normalizeRuleInput(input);

    return withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `
          UPDATE public.mqtt_rules
          SET
            name = $2,
            enabled = $3,
            match_type = $4,
            match_value = NULLIF($5, ''),
            plate_match_mode = $6,
            fuzzy_enabled = $7,
            fuzzy_max_distance = $8,
            fuzzy_min_length = $9,
            fuzzy_require_unique = $10,
            fuzzy_ocr_aware = $11,
            broker_id = $12,
            destination_mode = $13,
            fixed_topic = NULLIF($14, ''),
            message = NULLIF($15, '')
          WHERE id = $1
          RETURNING id
        `,
        [
          ruleId,
          rule.name,
          rule.enabled,
          rule.matchType,
          rule.matchValue,
          rule.plateMatchMode,
          rule.fuzzyEnabled,
          rule.fuzzyMaxDistance,
          rule.fuzzyMinLength,
          rule.fuzzyRequireUnique,
          rule.fuzzyOcrAware,
          rule.brokerId,
          rule.destinationMode,
          rule.fixedTopic,
          rule.message,
        ]
      );

      if (!updated.rows[0]) return null;
      await replaceCameraLinks(client, ruleId, rule.cameraIds);
      const rules = await selectRule(client, ruleId);
      return rules[0];
    });
  }

  async deleteRule(id) {
    const ruleId = normalizeId(id);
    const result = await this.pool.query(
      `DELETE FROM public.mqtt_rules WHERE id = $1 RETURNING id`,
      [ruleId]
    );
    return result.rows.length > 0;
  }
}

export const mqttRuleAdminInternals = Object.freeze({
  normalizeId,
  normalizeCameraIds,
  normalizePlateMatchMode,
  normalizeRuleInput,
  mapRule,
  mapOptions,
});
