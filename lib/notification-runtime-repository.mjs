import { createHash } from "node:crypto";

function ensureExecutor(executor) {
  if (!executor || typeof executor.query !== "function") {
    throw new Error("NotificationRuntimeRepository requires a PostgreSQL-compatible executor");
  }
  return executor;
}

function buildConditionTrees(groupRows, conditionRows) {
  const groups = new Map();
  for (const row of groupRows) {
    groups.set(String(row.id), {
      id: row.id,
      kind: "group",
      combinator: row.combinator,
      negated: Boolean(row.negated),
      position: Number(row.position),
      ruleId: row.rule_id,
      parentGroupId: row.parent_group_id,
      children: [],
    });
  }
  for (const row of conditionRows) {
    groups.get(String(row.group_id))?.children.push({
      id: row.id,
      kind: "condition",
      conditionType: row.condition_type,
      operator: row.operator,
      value: row.operand || {},
      position: Number(row.position),
    });
  }
  for (const group of groups.values()) {
    if (group.parentGroupId != null) {
      groups.get(String(group.parentGroupId))?.children.push(group);
    }
  }
  for (const group of groups.values()) {
    group.children.sort(
      (left, right) => left.position - right.position || String(left.id).localeCompare(String(right.id))
    );
  }
  return new Map(
    [...groups.values()]
      .filter((group) => group.parentGroupId == null)
      .map((group) => [String(group.ruleId), group])
  );
}

function collectReadCountRequirements(rules = []) {
  const requirements = new Map();
  const visit = (node) => {
    if (!node) return;
    if (node.kind === "group") {
      for (const child of node.children || []) visit(child);
      return;
    }
    if (node.conditionType !== "read_count") return;
    const scope = ["plate", "camera", "global"].includes(node.value?.scope) ? node.value.scope : "plate";
    const windowSeconds = Number(node.value?.windowSeconds ?? node.value?.window_seconds ?? 0);
    if (!Number.isInteger(windowSeconds) || windowSeconds < 0) return;
    requirements.set(`${scope}:${windowSeconds}`, { scope, windowSeconds });
  };
  for (const rule of rules) visit(rule.conditionTree);
  return [...requirements.values()];
}

export class NotificationRuntimeRepository {
  constructor({ executor } = {}) {
    this.executor = ensureExecutor(executor);
  }

  async loadEnabledRules() {
    const [rulesResult, groupsResult, conditionsResult, actionsResult] = await Promise.all([
      this.executor.query(`
        SELECT r.id, r.name, r.description, r.event_type, r.cooldown_seconds, r.version,
               r.time_zone, r.quiet_hours, r.evaluation_interval_seconds,
               r.next_evaluation_at
        FROM public.notification_rules r
        WHERE r.enabled = TRUE
          AND r.deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM public.notification_actions a
            JOIN public.notification_channels ch ON ch.id = a.channel_id
            WHERE a.rule_id = r.id
              AND a.retired_at IS NULL
              AND a.enabled = TRUE
              AND ch.enabled = TRUE
              AND ch.channel_type IN ('mqtt', 'pushover', 'email', 'webhook')
          )
        ORDER BY r.id
      `),
      this.executor.query(`
        SELECT g.id, g.rule_id, g.parent_group_id, g.combinator, g.negated, g.position
        FROM public.notification_condition_groups g
        JOIN public.notification_rules r ON r.id = g.rule_id
        WHERE r.enabled = TRUE AND r.deleted_at IS NULL
        ORDER BY g.rule_id, g.position, g.id
      `),
      this.executor.query(`
        SELECT c.id, c.group_id, c.condition_type, c.operator, c.operand, c.position
        FROM public.notification_conditions c
        JOIN public.notification_condition_groups g ON g.id = c.group_id
        JOIN public.notification_rules r ON r.id = g.rule_id
        WHERE r.enabled = TRUE AND r.deleted_at IS NULL
        ORDER BY g.rule_id, c.group_id, c.position, c.id
      `),
      this.executor.query(`
        SELECT a.id, a.rule_id, a.position, a.configuration,
               ch.id AS channel_id, ch.channel_type, ch.credential_reference,
               ch.configuration AS channel_configuration
        FROM public.notification_actions a
        JOIN public.notification_channels ch ON ch.id = a.channel_id
        JOIN public.notification_rules r ON r.id = a.rule_id
        WHERE r.enabled = TRUE
          AND r.deleted_at IS NULL
          AND a.retired_at IS NULL
          AND a.enabled = TRUE
          AND ch.enabled = TRUE
          AND ch.channel_type IN ('mqtt', 'pushover', 'email', 'webhook')
        ORDER BY a.rule_id, a.position, a.id
      `),
    ]);

    const trees = buildConditionTrees(groupsResult.rows, conditionsResult.rows);
    const actionsByRule = new Map();
    for (const row of actionsResult.rows) {
      const key = String(row.rule_id);
      const actions = actionsByRule.get(key) || [];
      actions.push({
        id: Number(row.id),
        enabled: true,
        position: Number(row.position),
        channelId: Number(row.channel_id),
        channelType: row.channel_type,
        credentialReference: row.credential_reference,
        configuration: {
          ...(row.channel_configuration || {}),
          ...(row.configuration || {}),
        },
      });
      actionsByRule.set(key, actions);
    }

    return rulesResult.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      description: row.description,
      enabled: true,
      eventTypes: [row.event_type],
      cooldownSeconds: Number(row.cooldown_seconds),
      timeZone: row.time_zone || "UTC",
      quietHours: row.quiet_hours || { enabled: false },
      evaluationIntervalSeconds: row.evaluation_interval_seconds == null
        ? null
        : Number(row.evaluation_interval_seconds),
      nextEvaluationAt: row.next_evaluation_at || null,
      version: Number(row.version),
      conditionTree: trees.get(String(row.id)) || null,
      actions: actionsByRule.get(String(row.id)) || [],
    }));
  }

  async loadEnabledMqttRules() {
    return (await this.loadEnabledRules()).filter((rule) =>
      rule.actions.some((action) => action.channelType === "mqtt")
    );
  }

  async loadPlateContext({ plateNumber } = {}) {
    const plate = String(plateNumber ?? "").trim().toUpperCase();
    if (!plate) throw new Error("Notification plate context requires a plate number");
    const result = await this.executor.query(`
      SELECT requested.plate_number,
             (kp.plate_number IS NOT NULL) AS known_plate,
             COALESCE(kp.name, '') AS known_name,
             COALESCE(p.flagged, FALSE) AS watchlisted,
             COALESCE(
               array_agg(DISTINCT t.name ORDER BY t.name)
                 FILTER (WHERE t.name IS NOT NULL),
               ARRAY[]::varchar[]
             ) AS tags
      FROM (SELECT $1::varchar AS plate_number) requested
      LEFT JOIN public.plates p ON p.plate_number = requested.plate_number
      LEFT JOIN public.known_plates kp ON kp.plate_number = requested.plate_number
      LEFT JOIN public.plate_tags pt ON pt.plate_number = requested.plate_number
      LEFT JOIN public.tags t ON t.id = pt.tag_id
      GROUP BY requested.plate_number, kp.plate_number, kp.name, p.flagged
    `, [plate]);
    const row = result.rows[0] || {};
    return {
      plateNumber: row.plate_number || plate,
      knownPlate: Boolean(row.known_plate),
      knownName: row.known_name || "",
      tags: Array.isArray(row.tags) ? row.tags.filter(Boolean) : [],
      watchlisted: Boolean(row.watchlisted),
    };
  }

  async loadLastMatchedAt(ruleIds = []) {
    const ids = [...new Set(ruleIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (ids.length === 0) return {};
    const result = await this.executor.query(`
      SELECT rule_id, MAX(evaluated_at) AS last_matched_at
      FROM public.notification_executions
      WHERE rule_id = ANY($1::bigint[]) AND outcome = 'matched'
      GROUP BY rule_id
    `, [ids]);
    return Object.fromEntries(result.rows.map((row) => [String(row.rule_id), row.last_matched_at]));
  }

  async loadLastMatchedAtForActivity({ ruleId, cameraKey } = {}) {
    const prefix = `camera-activity:${String(cameraKey || "")}:`;
    const result = await this.executor.query(`
      SELECT MAX(evaluated_at) AS last_matched_at
      FROM public.notification_executions
      WHERE rule_id = $1::bigint AND event_type = 'camera.activity_check'
        AND outcome = 'matched' AND LEFT(event_id, LENGTH($2)) = $2
    `, [Number(ruleId), prefix]);
    return result.rows[0]?.last_matched_at || null;
  }

  async loadReadCountMetrics({ rules = [], event = {} } = {}) {
    const requirements = collectReadCountRequirements(rules);
    if (requirements.length === 0) return { readCounts: [] };
    const timestamp = event.timestamp ?? event.persistedTimestamp ?? event.persisted_timestamp;
    const plateNumber = event.effectivePlate ?? event.plateNumber ?? event.plate_number ?? "";
    const cameraName = event.cameraName ?? event.camera_name ?? "";
    const readCounts = await Promise.all(requirements.map(async ({ scope, windowSeconds }) => {
      const result = await this.executor.query(`
        SELECT COUNT(*)::integer AS count
        FROM public.plate_reads pr
        WHERE pr.timestamp <= $1::timestamptz
          AND ($2::integer = 0 OR pr.timestamp > $1::timestamptz - ($2::text || ' seconds')::interval)
          AND ($3::text <> 'plate' OR pr.plate_number = $4)
          AND ($3::text <> 'camera' OR pr.camera_name = $5)
      `, [timestamp, windowSeconds, scope, plateNumber, cameraName]);
      return { scope, windowSeconds, count: Number(result.rows[0]?.count || 0) };
    }));
    return { readCounts };
  }

  async recordExecutions({ readId = null, eventId, eventType = "plate_read.accepted", decisions } = {}) {
    const recorded = [];
    for (const decision of decisions || []) {
      const executionKey = eventType === "plate_read.accepted"
        ? `notification-v2:read:${readId}:${decision.ruleId}:${decision.version}`
        : `notification-v2:${createHash("sha256").update(`${eventId}\u0000${decision.ruleId}\u0000${decision.version}`).digest("hex")}`;
      const result = await this.executor.query(
        `
          INSERT INTO public.notification_executions
            (execution_key, event_id, event_type, read_id, rule_id, rule_version,
             outcome, reason, decision)
          VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8, $9::jsonb)
          ON CONFLICT (execution_key) DO UPDATE
            SET execution_key = EXCLUDED.execution_key
          RETURNING id
        `,
        [
          executionKey,
          eventId,
          eventType,
          readId,
          decision.ruleId,
          decision.version,
          decision.outcome,
          decision.reason,
          JSON.stringify({
            matched: Boolean(decision.matched),
            shouldDeliver: Boolean(decision.shouldDeliver),
            trace: decision.trace || null,
            quietHours: decision.quietHours || null,
            eventTime: decision.eventTime || null,
            timeZone: decision.timeZone || null,
          }),
        ]
      );
      recorded.push({ ...decision, executionId: Number(result.rows[0].id) });
    }
    return recorded;
  }

  async enqueueDelivery({ executionId, action, payload, maxAttempts = 5 } = {}) {
    const dedupeKey = `notification-v2:${executionId}:${action.id}:${action.channelId}`;
    const result = await this.executor.query(`
      WITH inserted AS (
        INSERT INTO public.notification_deliveries
          (dedupe_key, execution_id, action_id, channel_id, payload, max_attempts)
        VALUES ($1, $2::bigint, $3::bigint, $4::bigint, $5::jsonb, $6)
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING *, TRUE AS inserted
      )
      SELECT * FROM inserted
      UNION ALL
      SELECT d.*, FALSE AS inserted
      FROM public.notification_deliveries d
      WHERE d.dedupe_key = $1 AND NOT EXISTS (SELECT 1 FROM inserted)
      LIMIT 1
    `, [dedupeKey, executionId, action.id, action.channelId, JSON.stringify(payload || {}), maxAttempts]);
    return { ...result.rows[0], id: Number(result.rows[0].id), inserted: Boolean(result.rows[0].inserted) };
  }

  async claimDueDeliveries({
    workerId,
    limit = 10,
    now = new Date(),
    channelTypes = ["pushover", "email", "webhook"],
  } = {}) {
    const supported = [...new Set(channelTypes.map(String))]
      .filter((value) => ["pushover", "email", "webhook"].includes(value));
    if (supported.length === 0) return [];
    const result = await this.executor.query(`
      WITH due AS (
        SELECT d.id
        FROM public.notification_deliveries d
        JOIN public.notification_channels ch ON ch.id = d.channel_id
        WHERE d.status IN ('pending', 'retry')
          AND d.next_attempt_at <= $2::timestamptz
          AND ch.channel_type = ANY($4::text[])
        ORDER BY d.next_attempt_at, d.id
        FOR UPDATE OF d SKIP LOCKED
        LIMIT $3
      ), claimed AS (
        UPDATE public.notification_deliveries d
        SET status = 'processing', locked_at = $2::timestamptz, locked_by = $1
        FROM due WHERE d.id = due.id
        RETURNING d.*
      )
      SELECT claimed.*, r.name AS rule_name, ch.channel_type, ch.credential_reference
      FROM claimed
      JOIN public.notification_executions e ON e.id = claimed.execution_id
      JOIN public.notification_rules r ON r.id = e.rule_id
      JOIN public.notification_channels ch ON ch.id = claimed.channel_id
      ORDER BY claimed.next_attempt_at, claimed.id
    `, [String(workerId), now, Math.max(1, Math.min(100, Number(limit) || 10)), supported]);
    return result.rows.map((row) => ({
      ...row,
      id: Number(row.id),
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      channelType: row.channel_type,
      credentialReference: row.credential_reference,
    }));
  }

  async claimDuePushoverDeliveries(options = {}) {
    return this.claimDueDeliveries({ ...options, channelTypes: ["pushover"] });
  }

  async releaseExpiredDeliveryLeases({
    leaseMs = 60_000,
    now = new Date(),
    channelTypes = ["pushover", "email", "webhook"],
  } = {}) {
    const cutoff = new Date(new Date(now).getTime() - Number(leaseMs));
    const supported = [...new Set(channelTypes.map(String))]
      .filter((value) => ["pushover", "email", "webhook"].includes(value));
    if (supported.length === 0) return [];
    const result = await this.executor.query(`
      UPDATE public.notification_deliveries d
      SET status = 'retry', next_attempt_at = $1, locked_at = NULL, locked_by = NULL,
          last_error = COALESCE(last_error, 'Notification worker lease expired')
      FROM public.notification_channels ch
      WHERE d.channel_id = ch.id AND ch.channel_type = ANY($3::text[])
        AND d.status = 'processing' AND (d.locked_at IS NULL OR d.locked_at <= $2)
      RETURNING d.id
    `, [now, cutoff, supported]);
    return result.rows.map((row) => Number(row.id));
  }

  async releaseExpiredPushoverLeases(options = {}) {
    return this.releaseExpiredDeliveryLeases({ ...options, channelTypes: ["pushover"] });
  }

  async recordDeliverySuccess({ deliveryId, workerId, response = {}, now = new Date() } = {}) {
    const result = await this.executor.query(`
      WITH updated AS (
        UPDATE public.notification_deliveries
        SET status = 'succeeded', attempt_count = attempt_count + 1,
            locked_at = NULL, locked_by = NULL, last_error = NULL, delivered_at = $3
        WHERE id = $1::bigint AND status = 'processing' AND locked_by = $2
        RETURNING *, locked_at AS attempt_started_at
      ), attempted AS (
        INSERT INTO public.notification_delivery_attempts
          (delivery_id, attempt_number, outcome, response, started_at, completed_at)
        SELECT id, attempt_count, 'succeeded', $4::jsonb,
               COALESCE(attempt_started_at, $3), $3 FROM updated
        RETURNING delivery_id
      )
      SELECT updated.* FROM updated JOIN attempted ON attempted.delivery_id = updated.id
    `, [deliveryId, String(workerId), now, JSON.stringify(response || {})]);
    if (!result.rows[0]) throw new Error("Notification delivery success could not be recorded because its worker lease was lost");
    return result.rows[0];
  }

  async recordPushoverSuccess(options = {}) { return this.recordDeliverySuccess(options); }

  async recordDeliveryFailure({ deliveryId, workerId, error, now = new Date() } = {}) {
    const message = String(error?.message ?? error ?? "Notification delivery failed").slice(0, 4000);
    const retryable = error?.retryable !== false;
    const result = await this.executor.query(`
      WITH updated AS (
        UPDATE public.notification_deliveries
        SET attempt_count = attempt_count + 1,
            status = CASE WHEN $5::boolean = FALSE OR attempt_count + 1 >= max_attempts THEN 'dead' ELSE 'retry' END,
            next_attempt_at = CASE WHEN $5::boolean = FALSE OR attempt_count + 1 >= max_attempts THEN next_attempt_at
              ELSE $3::timestamptz + (LEAST(300, POWER(2, attempt_count)::integer) || ' seconds')::interval END,
            locked_at = NULL, locked_by = NULL, last_error = $4
        WHERE id = $1::bigint AND status = 'processing' AND locked_by = $2
        RETURNING *, locked_at AS attempt_started_at
      ), attempted AS (
        INSERT INTO public.notification_delivery_attempts
          (delivery_id, attempt_number, outcome, error, started_at, completed_at)
        SELECT id, attempt_count, 'failed', $4, COALESCE(attempt_started_at, $3), $3
        FROM updated RETURNING delivery_id
      )
      SELECT updated.* FROM updated JOIN attempted ON attempted.delivery_id = updated.id
    `, [deliveryId, String(workerId), now, message, retryable]);
    if (!result.rows[0]) throw new Error("Notification delivery failure could not be recorded because its worker lease was lost");
    return result.rows[0];
  }

  async recordPushoverFailure(options = {}) { return this.recordDeliveryFailure(options); }

  async claimDueActivityRuleIds({ workerId, limit = 20, now = new Date() } = {}) {
    const result = await this.executor.query(`
      WITH due AS (
        SELECT id
        FROM public.notification_rules
        WHERE enabled = TRUE AND deleted_at IS NULL AND event_type = 'camera.activity_check'
          AND evaluation_interval_seconds IS NOT NULL
          AND COALESCE(next_evaluation_at, $1::timestamptz) <= $1::timestamptz
        ORDER BY next_evaluation_at NULLS FIRST, id
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      )
      UPDATE public.notification_rules r
      SET next_evaluation_at = $1::timestamptz + (r.evaluation_interval_seconds || ' seconds')::interval,
          evaluation_locked_at = NULL, evaluation_locked_by = NULL
      FROM due WHERE r.id = due.id
      RETURNING r.id
    `, [now, Math.max(1, Math.min(100, Number(limit) || 20))]);
    return result.rows.map((row) => Number(row.id));
  }

  async loadOperationsHistory({ limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const result = await this.executor.query(`
      SELECT e.id, e.event_id, e.event_type, e.read_id, e.outcome, e.reason,
             e.decision, e.evaluated_at, r.id AS rule_id, r.name AS rule_name,
             COALESCE(jsonb_agg(jsonb_build_object(
               'id', d.id, 'status', d.status, 'attemptCount', d.attempt_count,
               'maxAttempts', d.max_attempts, 'lastError', d.last_error,
               'nextAttemptAt', d.next_attempt_at, 'deliveredAt', d.delivered_at,
               'channelType', ch.channel_type,
               'attempts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                 'number', da.attempt_number, 'outcome', da.outcome, 'error', da.error,
                 'startedAt', da.started_at, 'completedAt', da.completed_at
               ) ORDER BY da.attempt_number) FROM public.notification_delivery_attempts da
                 WHERE da.delivery_id = d.id), '[]'::jsonb)
             )) FILTER (WHERE d.id IS NOT NULL), '[]'::jsonb) AS deliveries
      FROM public.notification_executions e
      JOIN public.notification_rules r ON r.id = e.rule_id
      LEFT JOIN public.notification_deliveries d ON d.execution_id = e.id
      LEFT JOIN public.notification_channels ch ON ch.id = d.channel_id
      GROUP BY e.id, r.id, r.name
      ORDER BY e.evaluated_at DESC, e.id DESC
      LIMIT $1
    `, [safeLimit]);
    return result.rows.map((row) => ({
      id: Number(row.id), eventId: row.event_id, eventType: row.event_type,
      readId: row.read_id == null ? null : Number(row.read_id), ruleId: Number(row.rule_id),
      ruleName: row.rule_name, outcome: row.outcome, reason: row.reason,
      decision: row.decision || {}, evaluatedAt: row.evaluated_at,
      deliveries: row.deliveries || [],
    }));
  }
}

export const notificationRuntimeRepositoryInternals = Object.freeze({
  buildConditionTrees,
  collectReadCountRequirements,
  ensureExecutor,
});
