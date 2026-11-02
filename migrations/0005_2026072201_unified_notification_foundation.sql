-- migration: 2026072201_unified_notification_foundation
-- Channel-neutral notification rule foundation -----------------------------
-- This schema is intentionally inert until existing Pushover and MQTT paths
-- are migrated in a later release. New rules default disabled, and this
-- migration neither copies nor changes any existing notification behavior.
CREATE TABLE IF NOT EXISTS public.notification_rules (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    event_type VARCHAR(50) NOT NULL DEFAULT 'plate_read.accepted'
        CHECK (event_type IN ('plate_read.accepted', 'camera.activity_check')),
    cooldown_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (cooldown_seconds BETWEEN 0 AND 2678400),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notification_rules_name_present
        CHECK (NULLIF(BTRIM(name), '') IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.notification_condition_groups (
    id BIGSERIAL PRIMARY KEY,
    rule_id BIGINT NOT NULL REFERENCES public.notification_rules(id) ON DELETE CASCADE,
    parent_group_id BIGINT,
    combinator VARCHAR(10) NOT NULL DEFAULT 'all'
        CHECK (combinator IN ('all', 'any', 'not')),
    negated BOOLEAN NOT NULL DEFAULT FALSE,
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    UNIQUE (id, rule_id),
    CONSTRAINT notification_condition_groups_parent_same_rule
        FOREIGN KEY (parent_group_id, rule_id)
        REFERENCES public.notification_condition_groups(id, rule_id)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_condition_groups_root
    ON public.notification_condition_groups (rule_id)
    WHERE parent_group_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_condition_groups_parent
    ON public.notification_condition_groups (parent_group_id, position);

CREATE TABLE IF NOT EXISTS public.notification_conditions (
    id BIGSERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL
        REFERENCES public.notification_condition_groups(id) ON DELETE CASCADE,
    condition_type VARCHAR(50) NOT NULL
        CHECK (condition_type IN (
            'always',
            'event_type',
            'plate_match',
            'camera',
            'known_plate',
            'known_name',
            'tag',
            'watchlist',
            'confidence',
            'read_count',
            'local_time_window'
        )),
    operator VARCHAR(30) NOT NULL,
    operand JSONB NOT NULL DEFAULT '{}'::JSONB,
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    CONSTRAINT notification_conditions_operand_object
        CHECK (jsonb_typeof(operand) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_notification_conditions_group
    ON public.notification_conditions (group_id, position, id);

CREATE TABLE IF NOT EXISTS public.notification_channels (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    channel_type VARCHAR(30) NOT NULL
        CHECK (channel_type IN ('pushover', 'mqtt', 'email', 'webhook')),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    credential_reference VARCHAR(255),
    configuration JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notification_channels_name_present
        CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
    CONSTRAINT notification_channels_configuration_object
        CHECK (jsonb_typeof(configuration) = 'object')
);

COMMENT ON COLUMN public.notification_channels.credential_reference IS
    'Reference to separately protected credentials; never store a secret in this field.';

CREATE TABLE IF NOT EXISTS public.notification_actions (
    id BIGSERIAL PRIMARY KEY,
    rule_id BIGINT NOT NULL REFERENCES public.notification_rules(id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES public.notification_channels(id) ON DELETE RESTRICT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    configuration JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (rule_id, position),
    CONSTRAINT notification_actions_configuration_object
        CHECK (jsonb_typeof(configuration) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_notification_actions_channel
    ON public.notification_actions (channel_id);

CREATE TABLE IF NOT EXISTS public.notification_executions (
    id BIGSERIAL PRIMARY KEY,
    execution_key VARCHAR(100) NOT NULL UNIQUE,
    event_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE SET NULL,
    rule_id BIGINT NOT NULL REFERENCES public.notification_rules(id) ON DELETE RESTRICT,
    rule_version INTEGER NOT NULL CHECK (rule_version > 0),
    outcome VARCHAR(30) NOT NULL
        CHECK (outcome IN (
            'matched', 'not_matched', 'suppressed', 'disabled',
            'event_filtered', 'invalid', 'error'
        )),
    reason VARCHAR(100) NOT NULL,
    decision JSONB NOT NULL DEFAULT '{}'::JSONB,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notification_executions_decision_object
        CHECK (jsonb_typeof(decision) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_notification_executions_rule_activity
    ON public.notification_executions (rule_id, evaluated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notification_executions_event
    ON public.notification_executions (event_id, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS public.notification_deliveries (
    id BIGSERIAL PRIMARY KEY,
    dedupe_key VARCHAR(100) NOT NULL UNIQUE,
    execution_id BIGINT NOT NULL
        REFERENCES public.notification_executions(id) ON DELETE CASCADE,
    action_id BIGINT NOT NULL REFERENCES public.notification_actions(id) ON DELETE RESTRICT,
    channel_id BIGINT NOT NULL REFERENCES public.notification_channels(id) ON DELETE RESTRICT,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'retry', 'succeeded', 'dead', 'cancelled')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts SMALLINT NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_at TIMESTAMPTZ,
    locked_by VARCHAR(255),
    last_error TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notification_deliveries_payload_object
        CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT notification_deliveries_lock_state CHECK (
        (status = 'processing' AND locked_at IS NOT NULL AND NULLIF(BTRIM(locked_by), '') IS NOT NULL)
        OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
    ),
    CONSTRAINT notification_deliveries_delivered_state CHECK (
        (status = 'succeeded' AND delivered_at IS NOT NULL)
        OR (status <> 'succeeded' AND delivered_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due
    ON public.notification_deliveries (next_attempt_at, id)
    WHERE status IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_activity
    ON public.notification_deliveries (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.notification_delivery_attempts (
    id BIGSERIAL PRIMARY KEY,
    delivery_id BIGINT NOT NULL
        REFERENCES public.notification_deliveries(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    response JSONB NOT NULL DEFAULT '{}'::JSONB,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (delivery_id, attempt_number),
    CONSTRAINT notification_delivery_attempts_response_object
        CHECK (jsonb_typeof(response) = 'object')
);

CREATE OR REPLACE FUNCTION public.notification_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_rules_set_updated_at ON public.notification_rules;
CREATE TRIGGER notification_rules_set_updated_at
BEFORE UPDATE ON public.notification_rules
FOR EACH ROW EXECUTE FUNCTION public.notification_set_updated_at();

DROP TRIGGER IF EXISTS notification_channels_set_updated_at ON public.notification_channels;
CREATE TRIGGER notification_channels_set_updated_at
BEFORE UPDATE ON public.notification_channels
FOR EACH ROW EXECUTE FUNCTION public.notification_set_updated_at();

DROP TRIGGER IF EXISTS notification_actions_set_updated_at ON public.notification_actions;
CREATE TRIGGER notification_actions_set_updated_at
BEFORE UPDATE ON public.notification_actions
FOR EACH ROW EXECUTE FUNCTION public.notification_set_updated_at();

DROP TRIGGER IF EXISTS notification_deliveries_set_updated_at ON public.notification_deliveries;
CREATE TRIGGER notification_deliveries_set_updated_at
BEFORE UPDATE ON public.notification_deliveries
FOR EACH ROW EXECUTE FUNCTION public.notification_set_updated_at();

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072201_unified_notification_foundation',
    'Add inert channel-neutral rules, nested conditions, actions, executions, deliveries, and attempts.'
)
ON CONFLICT (version) DO NOTHING;
