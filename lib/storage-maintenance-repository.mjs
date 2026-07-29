import { normalizeStorageMaintenanceConfig } from "./storage-maintenance-policy.mjs";
import { normalizeWebhookUrl } from "./webhook-notifications.mjs";

async function getDefaultPool() {
  return (await import("./db.js")).getPool();
}

function queryFrom(executor) {
  if (!executor || typeof executor.query !== "function") throw new Error("Storage maintenance repository requires a query executor");
  return executor.query.bind(executor);
}

function configFromRow(row = {}) {
  return normalizeStorageMaintenanceConfig({
    warningPercent: row.warning_percent,
    criticalPercent: row.critical_percent,
    checkIntervalSeconds: row.check_interval_seconds,
    staleAfterSeconds: row.stale_after_seconds,
    alertCooldownSeconds: row.alert_cooldown_seconds,
    emailEnabled: row.email_enabled,
    emailRecipients: row.email_recipients,
    webhookEnabled: row.webhook_enabled,
    webhookUrl: row.webhook_url,
    cleanupEnabled: row.cleanup_enabled,
    cleanupIntervalSeconds: row.cleanup_interval_seconds,
    automaticCategories: row.automatic_categories,
    orphanGraceSeconds: row.orphan_grace_seconds,
  });
}

export function publicStorageMaintenanceConfig(config = {}) {
  const normalized = normalizeStorageMaintenanceConfig(config);
  const { webhookUrl: _webhookUrl, ...publicConfig } = normalized;
  return {
    ...publicConfig,
    webhookConfigured: config.webhookConfigured === true || Boolean(String(config.webhookUrl ?? "").trim()),
  };
}

export async function getStorageMaintenanceConfig({ executor } = {}) {
  const database = executor || await getDefaultPool();
  const result = await queryFrom(database)(
    "SELECT * FROM public.storage_maintenance_config WHERE singleton = TRUE"
  );
  return configFromRow(result.rows?.[0]);
}

export async function saveStorageMaintenanceConfig({ executor, config, actor = null } = {}) {
  const database = executor || await getDefaultPool();
  const client = typeof database.connect === "function" ? await database.connect() : database;
  const query = queryFrom(client);
  const transactional = typeof database.connect === "function";
  const normalized = normalizeStorageMaintenanceConfig(config);
  const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0 ? Number(actor.id) : null;
  try {
    if (transactional) await query("BEGIN");
    const current = await query(
      "SELECT webhook_url FROM public.storage_maintenance_config WHERE singleton = TRUE FOR UPDATE"
    );
    if (normalized.webhookEnabled && !String(current.rows?.[0]?.webhook_url || "").trim()) {
      throw new Error("Configure a maintenance webhook destination before enabling maintenance webhooks.");
    }
    const result = await query(
    `UPDATE public.storage_maintenance_config SET
       warning_percent = $1, critical_percent = $2,
       check_interval_seconds = $3, stale_after_seconds = $4,
       alert_cooldown_seconds = $5, email_enabled = $6,
       email_recipients = $7::jsonb, webhook_enabled = $8,
       cleanup_enabled = FALSE,
       cleanup_interval_seconds = $9, automatic_categories = '[]'::jsonb,
       orphan_grace_seconds = $10, updated_by_user_id = $11::bigint,
       updated_at = CURRENT_TIMESTAMP
     WHERE singleton = TRUE RETURNING *`,
    [
      normalized.warningPercent,
      normalized.criticalPercent,
      normalized.checkIntervalSeconds,
      normalized.staleAfterSeconds,
      normalized.alertCooldownSeconds,
      normalized.emailEnabled,
      JSON.stringify(normalized.emailRecipients),
      normalized.webhookEnabled,
      normalized.cleanupIntervalSeconds,
      normalized.orphanGraceSeconds,
      actorId,
    ]
  );
    await query(
    `INSERT INTO public.audit_events (
       actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
     ) VALUES ($1::bigint, 'browser', 'maintenance.storage_config_updated',
       'storage-maintenance-config', 'singleton', 'succeeded', $2::jsonb)`,
    [actorId, JSON.stringify({
      warningPercent: normalized.warningPercent,
      criticalPercent: normalized.criticalPercent,
      cleanupEnabled: false,
      automaticCategories: [],
    })]
  );
    if (transactional) await query("COMMIT");
    return publicStorageMaintenanceConfig(configFromRow(result.rows?.[0]));
  } catch (error) {
    if (transactional) {
      try { await query("ROLLBACK"); } catch {}
    }
    throw error;
  } finally {
    if (transactional) client.release();
  }
}

async function mutateStorageMaintenanceWebhook({
  executor,
  actor = null,
  webhookUrl = null,
  clear = false,
} = {}) {
  const database = executor || await getDefaultPool();
  const client = typeof database.connect === "function" ? await database.connect() : database;
  const query = queryFrom(client);
  const transactional = typeof database.connect === "function";
  const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0 ? Number(actor.id) : null;
  const normalizedUrl = clear ? null : normalizeWebhookUrl(webhookUrl).toString();
  const eventType = clear
    ? "maintenance.storage_webhook_cleared"
    : "maintenance.storage_webhook_replaced";
  try {
    if (transactional) await query("BEGIN");
    const result = await query(
      `UPDATE public.storage_maintenance_config SET
         webhook_url = $1::text,
         webhook_enabled = CASE WHEN $1::text IS NULL THEN FALSE ELSE webhook_enabled END,
         updated_by_user_id = $2::bigint, updated_at = CURRENT_TIMESTAMP
       WHERE singleton = TRUE RETURNING *`,
      [normalizedUrl, actorId]
    );
    await query(
      clear
        ? `UPDATE public.maintenance_alert_deliveries SET
             payload = payload - 'url',
             status = CASE WHEN status IN ('pending', 'retry', 'processing') THEN 'dead' ELSE status END,
             locked_at = CASE WHEN status IN ('pending', 'retry', 'processing') THEN NULL ELSE locked_at END,
             locked_by = CASE WHEN status IN ('pending', 'retry', 'processing') THEN NULL ELSE locked_by END,
             last_error = CASE WHEN status IN ('pending', 'retry', 'processing')
               THEN 'Maintenance webhook destination was cleared before delivery'
               WHEN last_error IS NOT NULL THEN 'Maintenance webhook delivery error details were redacted'
               ELSE NULL END,
             updated_at = CURRENT_TIMESTAMP
           WHERE channel_type = 'webhook'`
        : `UPDATE public.maintenance_alert_deliveries SET
             payload = payload - 'url',
             last_error = CASE WHEN last_error IS NULL THEN NULL
               ELSE 'Maintenance webhook delivery error details were redacted' END,
             updated_at = CURRENT_TIMESTAMP
           WHERE channel_type = 'webhook' AND (payload ? 'url' OR last_error IS NOT NULL)`
    );
    await query(
      `INSERT INTO public.audit_events (
         actor_user_id, source, event_type, resource_type, resource_id, outcome, metadata
       ) VALUES ($1::bigint, 'browser', $2,
         'storage-maintenance-config', 'singleton', 'succeeded', $3::jsonb)`,
      [actorId, eventType, JSON.stringify({ webhookConfigured: !clear })]
    );
    if (transactional) await query("COMMIT");
    return publicStorageMaintenanceConfig(configFromRow(result.rows?.[0]));
  } catch (error) {
    if (transactional) {
      try { await query("ROLLBACK"); } catch {}
    }
    throw error;
  } finally {
    if (transactional) client.release();
  }
}

export async function replaceStorageMaintenanceWebhook({ executor, webhookUrl, actor = null } = {}) {
  return mutateStorageMaintenanceWebhook({ executor, webhookUrl, actor, clear: false });
}

export async function clearStorageMaintenanceWebhook({ executor, actor = null } = {}) {
  return mutateStorageMaintenanceWebhook({ executor, actor, clear: true });
}

export async function recordMaintenanceHeartbeat({ executor, runtimeName = "storage-maintenance", workerId, error = null, now = new Date() } = {}) {
  const database = executor || await getDefaultPool();
  const result = await queryFrom(database)(
    `INSERT INTO public.maintenance_runtime_state (
       runtime_name, worker_id, started_at, heartbeat_at, last_error, updated_at
     ) VALUES ($1, $2, $3, $3, $4, $3)
     ON CONFLICT (runtime_name) DO UPDATE SET
       worker_id = EXCLUDED.worker_id,
       started_at = COALESCE(maintenance_runtime_state.started_at, EXCLUDED.started_at),
       heartbeat_at = EXCLUDED.heartbeat_at,
       last_error = EXCLUDED.last_error,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [String(runtimeName), String(workerId || "unknown").slice(0, 255), now, error ? String(error).slice(0, 2000) : null]
  );
  return result.rows?.[0] || null;
}

export async function getMaintenanceRuntimeState({ executor, runtimeName = "storage-maintenance" } = {}) {
  const database = executor || await getDefaultPool();
  const result = await queryFrom(database)(
    "SELECT * FROM public.maintenance_runtime_state WHERE runtime_name = $1",
    [String(runtimeName)]
  );
  return result.rows?.[0] || null;
}

export async function recordStorageMeasurement({ executor, snapshot } = {}) {
  const database = executor || await getDefaultPool();
  const query = queryFrom(database);
  const filesystem = snapshot?.filesystem || {};
  const breakdown = snapshot?.breakdown || {};
  const result = await query(
    `INSERT INTO public.storage_measurements (
       measured_at, filesystem_total_bytes, filesystem_used_bytes,
       filesystem_available_bytes, filesystem_used_percent,
       source_image_bytes, source_image_count, thumbnail_bytes, thumbnail_count,
       derived_vehicle_image_bytes, derived_vehicle_image_count, database_bytes,
       docker_bytes, backup_bytes, host_snapshot_measured_at, errors
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
     RETURNING id`,
    [
      snapshot?.measuredAt || new Date(),
      filesystem.totalBytes ?? null,
      filesystem.usedBytes ?? null,
      filesystem.availableBytes ?? null,
      filesystem.usedPercent ?? null,
      breakdown.sourceImages?.bytes ?? null,
      breakdown.sourceImages?.count ?? null,
      breakdown.thumbnails?.bytes ?? null,
      breakdown.thumbnails?.count ?? null,
      breakdown.derivedVehicleImages?.bytes ?? null,
      breakdown.derivedVehicleImages?.count ?? null,
      breakdown.database?.bytes ?? null,
      breakdown.docker?.bytes ?? null,
      breakdown.backups?.bytes ?? null,
      breakdown.hostSnapshotMeasuredAt ?? null,
      JSON.stringify(snapshot?.errors || []),
    ]
  );
  return Number(result.rows?.[0]?.id) || null;
}

export const storageMaintenanceRepositoryInternals = Object.freeze({
  configFromRow,
  mutateStorageMaintenanceWebhook,
  queryFrom,
});
