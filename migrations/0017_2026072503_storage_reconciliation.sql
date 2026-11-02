-- migration: 2026072503_storage_reconciliation
-- Read-only storage reconciliation persists resumable traversal state and an
-- exact finding inventory. These tables do not provide any deletion action.
CREATE TABLE IF NOT EXISTS public.storage_reconciliation_runs (
    id BIGSERIAL PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'running',
    phase VARCHAR(30) NOT NULL DEFAULT 'filesystem',
    scan_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    max_plate_read_id BIGINT NOT NULL DEFAULT 0,
    plate_read_cursor BIGINT NOT NULL DEFAULT 0,
    files_scanned BIGINT NOT NULL DEFAULT 0,
    bytes_scanned BIGINT NOT NULL DEFAULT 0,
    references_checked BIGINT NOT NULL DEFAULT 0,
    recent_files_skipped BIGINT NOT NULL DEFAULT 0,
    skipped_entries BIGINT NOT NULL DEFAULT 0,
    error_count BIGINT NOT NULL DEFAULT 0,
    orphan_files BIGINT NOT NULL DEFAULT 0,
    orphan_bytes BIGINT NOT NULL DEFAULT 0,
    missing_reference_paths BIGINT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT storage_reconciliation_status CHECK (status IN ('running', 'completed', 'failed')),
    CONSTRAINT storage_reconciliation_phase CHECK (
        phase IN ('filesystem', 'plate-reads', 'completed')
    ),
    CONSTRAINT storage_reconciliation_counts CHECK (
        max_plate_read_id >= 0 AND
        plate_read_cursor >= 0 AND
        files_scanned >= 0 AND bytes_scanned >= 0 AND references_checked >= 0 AND
        recent_files_skipped >= 0 AND skipped_entries >= 0 AND error_count >= 0 AND
        orphan_files >= 0 AND orphan_bytes >= 0 AND missing_reference_paths >= 0
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_reconciliation_running
    ON public.storage_reconciliation_runs (status)
    WHERE status = 'running';

CREATE TABLE IF NOT EXISTS public.storage_reconciliation_directories (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES public.storage_reconciliation_runs(id) ON DELETE CASCADE,
    relative_path VARCHAR(2048) NOT NULL,
    cursor_name VARCHAR(255),
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (run_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_storage_reconciliation_directories_due
    ON public.storage_reconciliation_directories (run_id, completed, relative_path);

CREATE TABLE IF NOT EXISTS public.storage_reconciliation_items (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES public.storage_reconciliation_runs(id) ON DELETE CASCADE,
    finding_type VARCHAR(30) NOT NULL,
    relative_path VARCHAR(2048) NOT NULL,
    size_bytes BIGINT,
    modified_at TIMESTAMPTZ,
    reference_type VARCHAR(80),
    owner_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT storage_reconciliation_finding_type CHECK (
        finding_type IN ('orphan-file', 'missing-reference')
    ),
    CONSTRAINT storage_reconciliation_item_size CHECK (size_bytes IS NULL OR size_bytes >= 0),
    UNIQUE (run_id, finding_type, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_storage_reconciliation_items_review
    ON public.storage_reconciliation_items (run_id, finding_type, relative_path);

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072503_storage_reconciliation',
    'Add bounded resumable read-only storage reconciliation runs and durable orphan/missing-reference inventory.'
)
ON CONFLICT (version) DO NOTHING;
