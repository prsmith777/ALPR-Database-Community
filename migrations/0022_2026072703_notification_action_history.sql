-- migration: 2026072703_notification_action_history
-- Editing a disabled notification rule must not erase the action identity
-- retained by delivery history. Keep prior versions as inert historical rows
-- and reserve each position only within the current, non-retired action set.
ALTER TABLE IF EXISTS public.notification_actions
    ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS retired_by_user_id BIGINT
        REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.notification_actions
    DROP CONSTRAINT IF EXISTS notification_actions_rule_id_position_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_actions_active_position
    ON public.notification_actions (rule_id, position)
    WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notification_actions_retired
    ON public.notification_actions (rule_id, retired_at, id);

COMMENT ON COLUMN public.notification_actions.retired_at IS
    'Set when an edited rule replaces this action; delivery history continues to reference the retired row.';

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072703_notification_action_history',
    'Preserve delivered notification action identities when disabled rules are edited.'
)
ON CONFLICT (version) DO NOTHING;
