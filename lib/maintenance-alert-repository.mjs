import { createHash } from "node:crypto";

import {
  buildMaintenanceAlertPayload,
  decideMaintenanceAlert,
  maintenanceAlertFingerprint,
} from "./maintenance-alerts.mjs";

async function getDefaultPool() {
  return (await import("./db.js")).getPool();
}

function safeError(error) {
  return String(error?.message || error || "Maintenance alert delivery failed").slice(0, 4000);
}

function rowShape(row = {}) {
  return {
    eventKey: row.event_key,
    severity: row.severity,
    fingerprint: row.fingerprint,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    lastNotifiedAt: row.last_notified_at,
    nextEligibleAt: row.next_eligible_at,
    resolvedAt: row.resolved_at,
    occurrenceCount: Number(row.occurrence_count) || 0,
    suppressedCount: Number(row.suppressed_count) || 0,
    details: row.details || {},
  };
}

export class MaintenanceAlertRepository {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  async database() {
    return this.pool || await getDefaultPool();
  }

  async observe({ eventKey, severity, message, details = {}, settings = {}, now = new Date() } = {}) {
    const database = await this.database();
    if (typeof database.connect !== "function") throw new Error("Maintenance alerts require a transactional pool");
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT * FROM public.maintenance_alert_state WHERE event_key = $1 FOR UPDATE",
        [String(eventKey)]
      );
      const previous = existing.rows?.[0] || null;
      const decision = decideMaintenanceAlert({
        previous,
        severity,
        now,
        cooldownSeconds: settings.alertCooldownSeconds,
      });
      const fingerprint = maintenanceAlertFingerprint(details);
      const payload = buildMaintenanceAlertPayload({ eventKey, severity, message, details, observedAt: now });
      const channels = [];
      if (decision.notify && settings.emailEnabled && Array.isArray(settings.emailRecipients) && settings.emailRecipients.length) {
        channels.push({ channelType: "email", payload: { ...payload, recipients: settings.emailRecipients, subject: payload.title } });
      }
      if (decision.notify && settings.webhookEnabled && settings.webhookUrl) {
        channels.push({
          channelType: "webhook",
          payload: {
            ...payload,
            body: {
              schema_version: 1,
              event_type: "maintenance.alert",
              event_key: payload.eventKey,
              severity,
              timestamp: payload.timestamp,
              message: payload.message,
              details,
            },
          },
        });
      }
      const notified = channels.length > 0;
      const cooldown = Math.max(300, Number(settings.alertCooldownSeconds) || 21_600);
      await client.query(
        `INSERT INTO public.maintenance_alert_state (
           event_key, severity, fingerprint, first_observed_at, last_observed_at,
           last_notified_at, next_eligible_at, resolved_at, occurrence_count,
           suppressed_count, details, updated_at
         ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, 1, $8, $9::jsonb, $4)
         ON CONFLICT (event_key) DO UPDATE SET
           severity = EXCLUDED.severity, fingerprint = EXCLUDED.fingerprint,
           first_observed_at = CASE
             WHEN maintenance_alert_state.severity = 'ok' AND EXCLUDED.severity <> 'ok'
               THEN EXCLUDED.first_observed_at
             ELSE maintenance_alert_state.first_observed_at END,
           last_observed_at = EXCLUDED.last_observed_at,
           last_notified_at = COALESCE(EXCLUDED.last_notified_at, maintenance_alert_state.last_notified_at),
           next_eligible_at = COALESCE(EXCLUDED.next_eligible_at, maintenance_alert_state.next_eligible_at),
           resolved_at = EXCLUDED.resolved_at,
           occurrence_count = maintenance_alert_state.occurrence_count + 1,
           suppressed_count = maintenance_alert_state.suppressed_count + EXCLUDED.suppressed_count,
           details = EXCLUDED.details, updated_at = EXCLUDED.updated_at`,
        [
          payload.eventKey,
          severity,
          fingerprint,
          now,
          notified ? now : null,
          notified ? new Date(new Date(now).getTime() + cooldown * 1000) : null,
          severity === "ok" ? now : null,
          decision.reason === "rate-limited" ? 1 : 0,
          JSON.stringify(details),
        ]
      );
      for (const channel of channels) {
        const dedupeKey = createHash("sha256")
          .update(`${payload.eventKey}\0${severity}\0${new Date(now).toISOString()}\0${channel.channelType}`)
          .digest("hex");
        await client.query(
          `INSERT INTO public.maintenance_alert_deliveries (
             dedupe_key, event_key, channel_type, payload
           ) VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [dedupeKey, payload.eventKey, channel.channelType, JSON.stringify(channel.payload)]
        );
      }
      await client.query("COMMIT");
      return { ...decision, notified, channels: channels.map((item) => item.channelType), payload };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async claimDue({ workerId, limit = 10, now = new Date() } = {}) {
    const database = await this.database();
    const result = await database.query(
      `WITH due AS (
         SELECT id FROM public.maintenance_alert_deliveries
         WHERE status IN ('pending', 'retry') AND next_attempt_at <= $2
         ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT $3
       )
       UPDATE public.maintenance_alert_deliveries delivery
       SET status = 'processing', locked_at = $2, locked_by = $1, updated_at = $2
       FROM due WHERE delivery.id = due.id RETURNING delivery.*`,
      [String(workerId), now, Math.max(1, Math.min(100, Number(limit) || 10))]
    );
    return (result.rows || []).map((row) => ({
      ...row,
      id: Number(row.id),
      channelType: row.channel_type,
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
    }));
  }

  async releaseExpiredLeases({ now = new Date(), leaseMs = 60_000 } = {}) {
    const database = await this.database();
    const cutoff = new Date(new Date(now).getTime() - leaseMs);
    const result = await database.query(
      `UPDATE public.maintenance_alert_deliveries
       SET status = 'retry', locked_at = NULL, locked_by = NULL,
           next_attempt_at = $1, last_error = COALESCE(last_error, 'Maintenance alert worker lease expired'),
           updated_at = $1
       WHERE status = 'processing' AND (locked_at IS NULL OR locked_at <= $2)
       RETURNING id`,
      [now, cutoff]
    );
    return (result.rows || []).map((row) => Number(row.id));
  }

  async recordSuccess({ deliveryId, workerId, response = {}, now = new Date() } = {}) {
    const database = await this.database();
    const result = await database.query(
      `UPDATE public.maintenance_alert_deliveries
       SET status = 'succeeded', attempt_count = attempt_count + 1,
           locked_at = NULL, locked_by = NULL, last_error = NULL,
           delivered_at = $3, updated_at = $3,
           payload = payload || jsonb_build_object('deliveryResponse', $4::jsonb)
       WHERE id = $1::bigint AND status = 'processing' AND locked_by = $2
       RETURNING *`,
      [deliveryId, String(workerId), now, JSON.stringify(response)]
    );
    if (!result.rows?.[0]) throw new Error("Maintenance alert delivery lease was lost");
    return result.rows[0];
  }

  async recordFailure({ deliveryId, workerId, error, now = new Date() } = {}) {
    const database = await this.database();
    const retryable = error?.retryable !== false;
    const result = await database.query(
      `UPDATE public.maintenance_alert_deliveries
       SET attempt_count = attempt_count + 1,
           status = CASE
             WHEN $5 = FALSE OR attempt_count + 1 >= max_attempts THEN 'dead' ELSE 'retry' END,
           next_attempt_at = CASE
             WHEN $5 = FALSE OR attempt_count + 1 >= max_attempts THEN next_attempt_at
             ELSE $3 + (LEAST(300, POWER(2, attempt_count)::integer) || ' seconds')::interval END,
           locked_at = NULL, locked_by = NULL, last_error = $4, updated_at = $3
       WHERE id = $1::bigint AND status = 'processing' AND locked_by = $2
       RETURNING *`,
      [deliveryId, String(workerId), now, safeError(error), retryable]
    );
    if (!result.rows?.[0]) throw new Error("Maintenance alert delivery lease was lost");
    return result.rows[0];
  }

  async overview({ limit = 20 } = {}) {
    const database = await this.database();
    const [states, deliveries] = await Promise.all([
      database.query("SELECT * FROM public.maintenance_alert_state ORDER BY last_observed_at DESC LIMIT $1", [limit]),
      database.query("SELECT * FROM public.maintenance_alert_deliveries ORDER BY created_at DESC, id DESC LIMIT $1", [limit]),
    ]);
    return {
      states: (states.rows || []).map(rowShape),
      deliveries: (deliveries.rows || []).map((row) => ({
        id: Number(row.id), eventKey: row.event_key, channelType: row.channel_type,
        status: row.status, attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts),
        nextAttemptAt: row.next_attempt_at,
        lastError: row.channel_type === "webhook" && row.last_error
          ? "Webhook delivery failed; destination details are hidden."
          : row.last_error,
        deliveredAt: row.delivered_at,
      })),
    };
  }
}

export const maintenanceAlertRepositoryInternals = Object.freeze({ rowShape, safeError });
