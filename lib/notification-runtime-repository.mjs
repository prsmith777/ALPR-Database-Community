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

export class NotificationRuntimeRepository {
  constructor({ executor } = {}) {
    this.executor = ensureExecutor(executor);
  }

  async loadEnabledRules() {
    const [rulesResult, groupsResult, conditionsResult, actionsResult] = await Promise.all([
      this.executor.query(`
        SELECT r.id, r.name, r.description, r.event_type, r.cooldown_seconds, r.version
        FROM public.notification_rules r
        WHERE r.enabled = TRUE
          AND EXISTS (
            SELECT 1
            FROM public.notification_actions a
            JOIN public.notification_channels ch ON ch.id = a.channel_id
            WHERE a.rule_id = r.id
              AND a.enabled = TRUE
              AND ch.enabled = TRUE
              AND ch.channel_type IN ('mqtt', 'pushover')
          )
        ORDER BY r.id
      `),
      this.executor.query(`
        SELECT g.id, g.rule_id, g.parent_group_id, g.combinator, g.negated, g.position
        FROM public.notification_condition_groups g
        JOIN public.notification_rules r ON r.id = g.rule_id
        WHERE r.enabled = TRUE
        ORDER BY g.rule_id, g.position, g.id
      `),
      this.executor.query(`
        SELECT c.id, c.group_id, c.condition_type, c.operator, c.operand, c.position
        FROM public.notification_conditions c
        JOIN public.notification_condition_groups g ON g.id = c.group_id
        JOIN public.notification_rules r ON r.id = g.rule_id
        WHERE r.enabled = TRUE
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
          AND a.enabled = TRUE
          AND ch.enabled = TRUE
          AND ch.channel_type IN ('mqtt', 'pushover')
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

  async recordExecutions({ readId, eventId, decisions } = {}) {
    for (const decision of decisions || []) {
      await this.executor.query(
        `
          INSERT INTO public.notification_executions
            (execution_key, event_id, event_type, read_id, rule_id, rule_version,
             outcome, reason, decision)
          VALUES ($1, $2, 'plate_read.accepted', $3, $4::bigint, $5, $6, $7, $8::jsonb)
          ON CONFLICT (execution_key) DO NOTHING
        `,
        [
          `notification-v1:${readId}:${decision.ruleId}:${decision.version}`,
          eventId,
          readId,
          decision.ruleId,
          decision.version,
          decision.outcome,
          decision.reason,
          JSON.stringify({
            matched: Boolean(decision.matched),
            shouldDeliver: Boolean(decision.shouldDeliver),
            trace: decision.trace || null,
          }),
        ]
      );
    }
  }
}

export const notificationRuntimeRepositoryInternals = Object.freeze({
  buildConditionTrees,
  ensureExecutor,
});
