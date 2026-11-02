-- migration: 2026072902_automatic_derived_orphan_cleanup
-- Phase 2A: separately approved, bounded automatic cleanup for derived
-- orphans only. Approval history is append-only and defaults to no rows/off.
INSERT INTO public.permissions (permission_key, description)
VALUES (
    'maintenance.automatic_cleanup.approve',
    'Approve, suspend, or acknowledge automatic derived-orphan cleanup.'
)
ON CONFLICT (permission_key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM public.roles AS role
CROSS JOIN public.permissions AS permission
WHERE role.name = 'administrator'
  AND permission.permission_key = 'maintenance.automatic_cleanup.approve'
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.storage_cleanup_automatic_approvals (
    id BIGSERIAL PRIMARY KEY,
    category VARCHAR(40) NOT NULL CHECK (category = 'derived-orphans'),
    revision BIGINT NOT NULL CHECK (revision > 0),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    interval_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (interval_seconds BETWEEN 86400 AND 604800),
    grace_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (grace_seconds BETWEEN 604800 AND 31536000),
    actor_user_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (category, revision),
    CONSTRAINT storage_cleanup_approval_actor_fkey
        FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.storage_cleanup_automatic_state (
    category VARCHAR(40) PRIMARY KEY CHECK (category = 'derived-orphans'),
    next_run_at TIMESTAMPTZ,
    last_run_id BIGINT REFERENCES public.maintenance_runs(id) ON DELETE SET NULL,
    source_reconciliation_run_id BIGINT,
    circuit_breaker_open BOOLEAN NOT NULL DEFAULT FALSE,
    circuit_breaker_opened_at TIMESTAMPTZ,
    circuit_breaker_reason TEXT,
    circuit_breaker_run_id BIGINT REFERENCES public.maintenance_runs(id) ON DELETE SET NULL,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by_user_id BIGINT,
    acknowledged_run_id BIGINT,
    acknowledgement_reconciliation_run_id BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT storage_cleanup_state_ack_actor_fkey
        FOREIGN KEY (acknowledged_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT storage_cleanup_breaker_state CHECK (
        (circuit_breaker_open AND circuit_breaker_opened_at IS NOT NULL AND circuit_breaker_reason IS NOT NULL)
        OR (NOT circuit_breaker_open)
    ),
    CONSTRAINT storage_cleanup_ack_evidence CHECK (
        (acknowledged_at IS NULL AND acknowledged_run_id IS NULL AND acknowledgement_reconciliation_run_id IS NULL)
        OR (acknowledged_at IS NOT NULL AND acknowledged_run_id IS NOT NULL AND acknowledgement_reconciliation_run_id IS NOT NULL)
    )
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'storage_cleanup_approval_actor_fkey'
          AND conrelid = 'public.storage_cleanup_automatic_approvals'::regclass
    ) THEN
        ALTER TABLE public.storage_cleanup_automatic_approvals
            ADD CONSTRAINT storage_cleanup_approval_actor_fkey
            FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'storage_cleanup_state_ack_actor_fkey'
          AND conrelid = 'public.storage_cleanup_automatic_state'::regclass
    ) THEN
        ALTER TABLE public.storage_cleanup_automatic_state
            ADD CONSTRAINT storage_cleanup_state_ack_actor_fkey
            FOREIGN KEY (acknowledged_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END;
$$;

ALTER TABLE public.maintenance_runs
    ADD COLUMN IF NOT EXISTS source_reconciliation_run_id BIGINT;
ALTER TABLE public.storage_cleanup_automatic_state
    ADD COLUMN IF NOT EXISTS acknowledged_run_id BIGINT;
ALTER TABLE public.storage_cleanup_automatic_state
    ADD COLUMN IF NOT EXISTS acknowledgement_reconciliation_run_id BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'storage_cleanup_ack_evidence'
          AND conrelid = 'public.storage_cleanup_automatic_state'::regclass
    ) THEN
        ALTER TABLE public.storage_cleanup_automatic_state
            ADD CONSTRAINT storage_cleanup_ack_evidence CHECK (
                (acknowledged_at IS NULL AND acknowledged_run_id IS NULL AND acknowledgement_reconciliation_run_id IS NULL)
                OR (acknowledged_at IS NOT NULL AND acknowledged_run_id IS NOT NULL AND acknowledgement_reconciliation_run_id IS NOT NULL)
            );
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'maintenance_runs_source_reconciliation_fkey'
          AND conrelid = 'public.maintenance_runs'::regclass
    ) THEN
        ALTER TABLE public.maintenance_runs
            ADD CONSTRAINT maintenance_runs_source_reconciliation_fkey
            FOREIGN KEY (source_reconciliation_run_id)
            REFERENCES public.storage_reconciliation_runs(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'storage_cleanup_state_source_reconciliation_fkey'
          AND conrelid = 'public.storage_cleanup_automatic_state'::regclass
    ) THEN
        ALTER TABLE public.storage_cleanup_automatic_state
            ADD CONSTRAINT storage_cleanup_state_source_reconciliation_fkey
            FOREIGN KEY (source_reconciliation_run_id)
            REFERENCES public.storage_reconciliation_runs(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'storage_cleanup_state_acknowledged_run_fkey'
          AND conrelid = 'public.storage_cleanup_automatic_state'::regclass
    ) THEN
        ALTER TABLE public.storage_cleanup_automatic_state
            ADD CONSTRAINT storage_cleanup_state_acknowledged_run_fkey
            FOREIGN KEY (acknowledged_run_id)
            REFERENCES public.maintenance_runs(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'storage_cleanup_state_ack_reconciliation_fkey'
          AND conrelid = 'public.storage_cleanup_automatic_state'::regclass
    ) THEN
        ALTER TABLE public.storage_cleanup_automatic_state
            ADD CONSTRAINT storage_cleanup_state_ack_reconciliation_fkey
            FOREIGN KEY (acknowledgement_reconciliation_run_id)
            REFERENCES public.storage_reconciliation_runs(id) ON DELETE RESTRICT;
    END IF;
END;
$$;

ALTER TABLE public.maintenance_cleanup_items
    DROP CONSTRAINT IF EXISTS maintenance_cleanup_items_status_check;
ALTER TABLE public.maintenance_cleanup_items
    ADD CONSTRAINT maintenance_cleanup_items_status_check CHECK (
        status IN (
            'candidate', 'deleted', 'skipped-missing', 'skipped-changed',
            'skipped-referenced', 'skipped-unsafe', 'skipped-limit', 'failed'
        )
    );

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072902_automatic_derived_orphan_cleanup',
    'Add Administrator-only, revisioned and default-off automatic derived-orphan cleanup approval and circuit-breaker state.'
)
ON CONFLICT (version) DO NOTHING;
