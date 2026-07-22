import { buildNotificationShadowReview } from "./notification-shadow-review.mjs";

const TARGET_RULES_QUERY = `
  SELECT m.source_type, m.source_id, m.created_at AS migrated_at,
         r.id, r.name, r.description, r.enabled, r.event_type,
         r.cooldown_seconds, r.version
  FROM public.notification_rule_migrations m
  JOIN public.notification_rules r ON r.id = m.target_rule_id
  ORDER BY m.source_type, m.source_id
`;

const GROUPS_QUERY = `
  SELECT g.id, g.rule_id, g.parent_group_id, g.combinator, g.negated, g.position
  FROM public.notification_condition_groups g
  JOIN public.notification_rule_migrations m ON m.target_rule_id = g.rule_id
  ORDER BY g.rule_id, g.position, g.id
`;

const CONDITIONS_QUERY = `
  SELECT c.id, c.group_id, c.condition_type, c.operator, c.operand, c.position
  FROM public.notification_conditions c
  JOIN public.notification_condition_groups g ON g.id = c.group_id
  JOIN public.notification_rule_migrations m ON m.target_rule_id = g.rule_id
  ORDER BY g.rule_id, c.group_id, c.position, c.id
`;

const ACTIONS_QUERY = `
  SELECT a.id, a.rule_id, a.enabled, a.position, a.configuration,
         ch.id AS channel_id, ch.name AS channel_name, ch.channel_type,
         ch.enabled AS channel_enabled, ch.configuration AS channel_configuration
  FROM public.notification_actions a
  JOIN public.notification_channels ch ON ch.id = a.channel_id
  JOIN public.notification_rule_migrations m ON m.target_rule_id = a.rule_id
  ORDER BY a.rule_id, a.position, a.id
`;

const LEGACY_PUSHOVER_QUERY = `
  SELECT id, plate_number, plate_number AS name, enabled, priority
  FROM public.plate_notifications
  ORDER BY id
`;

const LEGACY_MQTT_QUERY = `
  SELECT r.id, r.name, r.enabled, r.match_type, r.match_value,
         r.plate_match_mode, r.fuzzy_enabled, r.fuzzy_max_distance,
         r.fuzzy_min_length, r.fuzzy_require_unique, r.fuzzy_ocr_aware,
         r.broker_id, r.destination_mode, r.fixed_topic, r.message,
         b.name AS broker_name, b.enabled AS broker_enabled,
         COALESCE(array_agg(c.id ORDER BY c.id) FILTER (WHERE c.id IS NOT NULL),
                  ARRAY[]::bigint[]) AS camera_ids,
         COALESCE(array_agg(c.camera_name ORDER BY c.id) FILTER (WHERE c.id IS NOT NULL),
                  ARRAY[]::varchar[]) AS camera_names
  FROM public.mqtt_rules r
  JOIN public.mqttbrokers b ON b.id = r.broker_id
  LEFT JOIN public.mqtt_rule_cameras rc ON rc.rule_id = r.id
  LEFT JOIN public.mqtt_cameras c ON c.id = rc.camera_id
  GROUP BY r.id, b.id
  ORDER BY r.id
`;

const RECENT_READS_QUERY = `
  SELECT pr.id, pr.plate_number,
         COALESCE(NULLIF(pr.observed_plate, ''), pr.plate_number) AS observed_plate,
         pr.timestamp, pr.camera_name, pr.confidence,
         (kp.plate_number IS NOT NULL) AS known_plate,
         COALESCE(kp.name, '') AS known_name,
         COALESCE(p.flagged, FALSE) AS watchlisted,
         COALESCE(array_agg(DISTINCT t.name ORDER BY t.name)
                    FILTER (WHERE t.name IS NOT NULL), ARRAY[]::varchar[]) AS tags,
         mc.id AS mqtt_camera_id, mc.camera_key
  FROM public.plate_reads pr
  LEFT JOIN public.plates p ON p.plate_number = pr.plate_number
  LEFT JOIN public.known_plates kp ON kp.plate_number = pr.plate_number
  LEFT JOIN public.plate_tags pt ON pt.plate_number = pr.plate_number
  LEFT JOIN public.tags t ON t.id = pt.tag_id
  LEFT JOIN public.mqtt_cameras mc ON LOWER(mc.camera_name) = LOWER(pr.camera_name)
  GROUP BY pr.id, kp.plate_number, kp.name, p.flagged, mc.id, mc.camera_key
  ORDER BY pr.timestamp DESC, pr.id DESC
  LIMIT $1
`;

const KNOWN_PLATES_QUERY = `
  SELECT kp.plate_number, kp.name,
         COALESCE(array_agg(DISTINCT t.name ORDER BY t.name)
                    FILTER (WHERE t.name IS NOT NULL), ARRAY[]::varchar[]) AS tags
  FROM public.known_plates kp
  LEFT JOIN public.plate_tags pt ON pt.plate_number = kp.plate_number
  LEFT JOIN public.tags t ON t.id = pt.tag_id
  GROUP BY kp.plate_number, kp.name
  ORDER BY kp.plate_number
`;

const REVIEWS_QUERY = `
  SELECT review.id, review.rule_id, review.rule_version, review.sample_count,
         review.agreement_count, review.mismatch_count, review.report_fingerprint,
         review.reviewed_at, COALESCE(u.username, 'Administrator') AS reviewer_name
  FROM public.notification_rule_shadow_reviews review
  LEFT JOIN public.users u ON u.id = review.reviewer_user_id
  ORDER BY review.rule_id, review.reviewed_at DESC, review.id DESC
`;

function ensurePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("NotificationShadowReviewRepository requires a PostgreSQL-compatible pool");
  }
  return pool;
}

function actorId(actor) {
  const value = Number(actor?.id);
  return Number.isInteger(value) && value > 0 ? value : null;
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
    if (group.parentGroupId != null) groups.get(String(group.parentGroupId))?.children.push(group);
  }
  for (const group of groups.values()) {
    group.children.sort((left, right) => left.position - right.position || String(left.id).localeCompare(String(right.id)));
  }
  return new Map(
    [...groups.values()]
      .filter((group) => group.parentGroupId == null)
      .map((group) => [String(group.ruleId), group])
  );
}

async function loadInputs(executor, sampleLimit) {
  const results = await Promise.all([
    executor.query(TARGET_RULES_QUERY),
    executor.query(GROUPS_QUERY),
    executor.query(CONDITIONS_QUERY),
    executor.query(ACTIONS_QUERY),
    executor.query(LEGACY_PUSHOVER_QUERY),
    executor.query(LEGACY_MQTT_QUERY),
    executor.query(RECENT_READS_QUERY, [sampleLimit]),
    executor.query(KNOWN_PLATES_QUERY),
    executor.query(REVIEWS_QUERY),
  ]);
  const [targets, groups, conditions, actions, pushover, mqtt, reads, known, reviews] = results;
  const trees = buildConditionTrees(groups.rows, conditions.rows);
  const actionsByRule = new Map();
  for (const row of actions.rows) {
    const key = String(row.rule_id);
    const values = actionsByRule.get(key) || [];
    values.push({
      id: row.id,
      enabled: Boolean(row.enabled),
      position: Number(row.position),
      configuration: row.configuration || {},
      channelId: row.channel_id,
      channelName: row.channel_name,
      channelType: row.channel_type,
      channelEnabled: Boolean(row.channel_enabled),
      channelConfiguration: row.channel_configuration || {},
    });
    actionsByRule.set(key, values);
  }
  const sources = new Map([
    ...pushover.rows.map((row) => [`pushover:${row.id}`, row]),
    ...mqtt.rows.map((row) => [`mqtt:${row.id}`, row]),
  ]);
  const entries = targets.rows.map((row) => ({
    sourceType: row.source_type,
    sourceId: row.source_id,
    migratedAt: row.migrated_at,
    sourceRule: sources.get(`${row.source_type}:${row.source_id}`) || {
      id: row.source_id,
      name: `Missing ${row.source_type} source #${row.source_id}`,
      enabled: false,
    },
    targetRule: {
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: Boolean(row.enabled),
      eventType: row.event_type,
      cooldownSeconds: Number(row.cooldown_seconds),
      version: Number(row.version),
      conditionTree: trees.get(String(row.id)) || null,
      actions: actionsByRule.get(String(row.id)) || [],
    },
  }));
  return { entries, recentReads: reads.rows, knownPlates: known.rows, reviews: reviews.rows };
}

export class NotificationShadowReviewRepository {
  constructor({ pool, sampleLimit = 50 } = {}) {
    this.pool = ensurePool(pool);
    this.sampleLimit = Math.max(1, Math.min(200, Number(sampleLimit) || 50));
  }

  async review({ matchingSettings = {} } = {}) {
    return buildNotificationShadowReview({
      ...(await loadInputs(this.pool, this.sampleLimit)),
      matchingSettings,
    });
  }

  async approve({ ruleId, actor = null, matchingSettings = {} } = {}) {
    if (typeof this.pool.connect !== "function") {
      throw new Error("Shadow review approval requires a transactional pool");
    }
    const parsedRuleId = Number(ruleId);
    if (!Number.isInteger(parsedRuleId) || parsedRuleId <= 0) {
      throw new Error("Select a valid unified rule to approve");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('alpr_notification_shadow_review'), $1::integer)",
        [parsedRuleId]
      );
      const report = buildNotificationShadowReview({
        ...(await loadInputs(client, this.sampleLimit)),
        matchingSettings,
      });
      const rule = report.rules.find((candidate) => Number(candidate.targetRule.id) === parsedRuleId);
      if (!rule) throw new Error("The migrated unified rule was not found");
      if (rule.status === "unsafe" || !rule.allDisabled || !rule.noDeliveries) {
        throw new Error("Approval blocked because the rule, channel, or action is not safely disabled");
      }
      if (rule.sampleCount === 0) throw new Error("Approval requires at least one relevant recent read");
      if (rule.mismatchCount > 0) throw new Error("Resolve shadow comparison mismatches before approval");
      if (rule.positiveMatchCount === 0) {
        throw new Error("Approval requires at least one positive legacy and unified match");
      }

      const inserted = await client.query(
        `
          INSERT INTO public.notification_rule_shadow_reviews
            (rule_id, rule_version, reviewer_user_id, sample_count,
             agreement_count, mismatch_count, report_fingerprint)
          VALUES ($1::bigint, $2, $3::bigint, $4, $5, 0, $6)
          ON CONFLICT (rule_id, rule_version, report_fingerprint) DO NOTHING
          RETURNING id, reviewed_at
        `,
        [
          parsedRuleId,
          rule.targetRule.version,
          actorId(actor),
          rule.sampleCount,
          rule.agreementCount,
          rule.reportFingerprint,
        ]
      );
      await client.query(
        `
          INSERT INTO public.audit_events
            (actor_user_id, source, event_type, resource_type, resource_id,
             outcome, metadata)
          VALUES ($1::bigint, 'browser', 'notification.shadow_review_approved',
                  'notification_rule', $2, 'succeeded', $3::jsonb)
        `,
        [
          actorId(actor),
          String(parsedRuleId),
          JSON.stringify({
            ruleVersion: rule.targetRule.version,
            sampleCount: rule.sampleCount,
            agreementCount: rule.agreementCount,
            positiveMatchCount: rule.positiveMatchCount,
            mismatchCount: 0,
            reportFingerprint: rule.reportFingerprint,
            ruleRemainedDisabled: true,
            deliveryAttempts: 0,
          }),
        ]
      );
      await client.query("COMMIT");
      return {
        ruleId: parsedRuleId,
        reportFingerprint: rule.reportFingerprint,
        sampleCount: rule.sampleCount,
        recorded: inserted.rowCount > 0,
        ruleRemainedDisabled: true,
        deliveryAttempts: 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const notificationShadowReviewRepositoryInternals = Object.freeze({
  ACTIONS_QUERY,
  CONDITIONS_QUERY,
  GROUPS_QUERY,
  KNOWN_PLATES_QUERY,
  LEGACY_MQTT_QUERY,
  LEGACY_PUSHOVER_QUERY,
  RECENT_READS_QUERY,
  REVIEWS_QUERY,
  TARGET_RULES_QUERY,
  buildConditionTrees,
  loadInputs,
});
