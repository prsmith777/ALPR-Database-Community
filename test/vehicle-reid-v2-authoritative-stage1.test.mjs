import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrations = await readFile(new URL("../migrations.sql", import.meta.url), "utf8");
const marker = migrations.indexOf("-- Additive authoritative ReID v2 ownership");
assert.notEqual(marker, -1, "Stage 1 ReID v2 migration marker must exist");
const stage1 = migrations.slice(marker);
const [repository, service, actions, panel, postgresGate, workflow] = await Promise.all([
  readFile(new URL("../lib/vehicle-reid-v2-conversion-repository.mjs", import.meta.url), "utf8"),
  readFile(new URL("../lib/vehicle-reid-v2-conversion-service.mjs", import.meta.url), "utf8"),
  readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
  readFile(new URL("../components/settings/VehicleReidV2ConversionPanel.jsx", import.meta.url), "utf8"),
  readFile(new URL("../scripts/test-vehicle-reid-v2-authoritative-postgres.mjs", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
]);

function tableBlock(tableName) {
  const declaration = `CREATE TABLE IF NOT EXISTS public.${tableName}`;
  const start = stage1.indexOf(declaration);
  assert.notEqual(start, -1, `${tableName} must be declared`);
  const next = stage1.indexOf("\nCREATE TABLE IF NOT EXISTS public.", start + declaration.length);
  return stage1.slice(start, next === -1 ? stage1.length : next);
}

function escaped(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("Stage 1 migration is additive and leaves authoritative v2 ownership empty", () => {
  for (const table of [
    "vehicle_reid_v2_profiles",
    "vehicle_reid_v2_profile_members",
    "vehicle_reid_v2_read_assignments",
    "vehicle_reid_control",
  ]) {
    assert.match(stage1, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${escaped(table)}`));
  }

  for (const table of [
    "vehicle_reid_v2_profiles",
    "vehicle_reid_v2_profile_members",
    "vehicle_reid_v2_read_assignments",
  ]) {
    assert.doesNotMatch(
      stage1,
      new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+public\\.${escaped(table)}\\b`, "i"),
      `${table} must remain empty after the additive migration`
    );
  }

  const control = tableBlock("vehicle_reid_control");
  assert.match(control, /mode VARCHAR\(16\) NOT NULL DEFAULT 'v2_shadow'/);
  assert.match(control, /'v1_primary','v2_shadow','v2_primary','v1_rollback'/);
  assert.match(stage1, /INSERT INTO public\.vehicle_reid_control[\s\S]*TRUE, 'v2_shadow'/);
  assert.match(stage1, /ON CONFLICT \(singleton\) DO NOTHING/);
  assert.match(stage1, /2026081603_vehicle_reid_v2_authoritative_stage1/);
});

test("frozen evidence and every projected preview result are immutable", () => {
  assert.match(
    stage1,
    /CREATE OR REPLACE FUNCTION public\.prevent_vehicle_reid_v2_conversion_snapshot_mutation\(\)/
  );
  const immutableTables = [
    "vehicle_reid_v2_conversion_crop_evidence",
    "vehicle_reid_v2_conversion_read_evidence",
    "vehicle_reid_v2_conversion_review_evidence",
    "vehicle_reid_v2_conversion_projected_profiles",
    "vehicle_reid_v2_conversion_projected_members",
    "vehicle_reid_v2_conversion_read_dispositions",
    "vehicle_reid_v2_conversion_conflicts",
    "vehicle_reid_v2_conversion_v1_comparisons",
  ];
  for (const table of immutableTables) {
    assert.match(
      stage1,
      new RegExp(`BEFORE INSERT OR UPDATE OR DELETE ON public\\.${escaped(table)}\\b`),
      `${table} must reject sealed appends and mutation`
    );
  }
  assert.match(
    stage1,
    /TG_TABLE_NAME = 'vehicle_reid_v2_conversion_read_dispositions'[\s\S]*runs\.phase = 'project_reads'/
  );
  assert.match(stage1, /runs\.phase = 'freeze'/);
  assert.match(
    tableBlock("vehicle_reid_v2_conversion_v1_comparisons"),
    /observation_only BOOLEAN NOT NULL DEFAULT TRUE CHECK \(observation_only = TRUE\)/
  );
});

test("conversion run state and revalidation audit remain fail-closed before acceptance", () => {
  const runs = tableBlock("vehicle_reid_v2_conversion_runs");
  assert.match(
    runs,
    /'previewing','ready','paused','accepted','running','completed',[\s\S]*'stale','cancelled','failed','rolled_back'/
  );
  assert.match(
    runs,
    /'freeze','project_profiles','project_reads','revalidate',[\s\S]*'materialize','complete'/
  );
  assert.match(runs, /identity_evidence_fingerprint CHAR\(64\)/);
  assert.match(runs, /preview_fingerprint CHAR\(64\)/);
  assert.match(runs, /accepted_preview_fingerprint CHAR\(64\)/);
  assert.match(runs, /last_revalidation_status VARCHAR\(16\) NOT NULL DEFAULT 'not_run'/);
  assert.match(runs, /last_revalidation_status IN \('not_run','current','stale','failed'\)/);
  assert.match(runs, /last_revalidation_fingerprint CHAR\(64\)/);
  assert.match(runs, /last_revalidated_at TIMESTAMPTZ/);
  assert.match(runs, /last_revalidation_error_code VARCHAR\(80\)/);
  assert.match(
    runs,
    /last_revalidation_status = 'current'[\s\S]*last_revalidation_fingerprint IS NOT NULL[\s\S]*last_revalidated_at IS NOT NULL/
  );
  assert.match(
    runs,
    /last_revalidation_status = 'stale'[\s\S]*last_revalidation_error_code IS NOT NULL/
  );
  assert.match(
    runs,
    /accepted_preview_fingerprint = preview_fingerprint[\s\S]*last_revalidation_status = 'current'[\s\S]*last_revalidation_fingerprint = identity_evidence_fingerprint/
  );
  assert.match(
    stage1,
    /idx_reid_v2_conversion_one_active[\s\S]*WHERE status IN \('previewing','ready','paused','accepted','running'\)/
  );
});

test("conversion jobs bound retries and require claim ownership while processing", () => {
  const jobs = tableBlock("vehicle_reid_v2_conversion_jobs");
  assert.match(jobs, /attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK \(attempt_count BETWEEN 0 AND 3\)/);
  assert.match(
    jobs,
    /operator_retry_count SMALLINT NOT NULL DEFAULT 0 CHECK \([\s\S]*operator_retry_count BETWEEN 0 AND 1/
  );
  assert.match(jobs, /status IN \('pending','processing','ready','stale','failed','cancelled'\)/);
  assert.match(jobs, /status = 'processing'[\s\S]*claim_token IS NOT NULL[\s\S]*processing_deadline_at IS NOT NULL/);
  assert.match(jobs, /status IN \('stale','failed'\) AND error_code IS NOT NULL/);
  assert.match(jobs, /UNIQUE \(run_id, work_key\)/);
});

test("a current canonical link without the exact crop and embedding is incomplete", () => {
  const reads = tableBlock("vehicle_reid_v2_conversion_read_evidence");
  assert.match(
    reads,
    /canonical_link_state IN \([\s\S]*'current','incomplete','display_only','stale','absent'/
  );
  assert.match(
    reads,
    /canonical_link_state = 'current'[\s\S]*asset_id IS NOT NULL[\s\S]*derivative_id IS NOT NULL[\s\S]*embedding_id IS NOT NULL[\s\S]*identity_eligible = TRUE/
  );
  assert.match(
    reads,
    /canonical_link_state = 'incomplete'[\s\S]*asset_id IS NOT NULL[\s\S]*identity_eligible = TRUE[\s\S]*\(derivative_id IS NULL OR embedding_id IS NULL\)/
  );
  assert.match(
    reads,
    /canonical_link_state = 'display_only'[\s\S]*identity_eligible = FALSE[\s\S]*relationship = 'display_fallback'/
  );
  assert.match(
    reads,
    /canonical_link_state <> 'absent'[\s\S]*asset_id IS NULL AND derivative_id IS NULL AND embedding_id IS NULL/
  );
});

test("Stage 1 runtime can only freeze and project; it cannot accept, materialize, or switch authority", () => {
  const runtime = `${repository}\n${service}`;
  for (const table of [
    "vehicle_reid_v2_profiles",
    "vehicle_reid_v2_profile_members",
    "vehicle_reid_v2_read_assignments",
  ]) {
    assert.doesNotMatch(
      runtime,
      new RegExp(`INSERT\\s+INTO\\s+public\\.${escaped(table)}\\b`, "i")
    );
  }
  assert.doesNotMatch(runtime, /UPDATE\s+public\.vehicle_reid_control/i);
  assert.match(repository, /BEGIN ISOLATION LEVEL/);
  assert.match(repository, /REPEATABLE READ/);
  assert.match(repository, /pg_advisory_xact_lock/);
  assert.match(repository, /FOR UPDATE SKIP LOCKED/);
  assert.match(repository, /attempt_count < 3/);
  assert.match(repository, /operator_retry_count < 1/);
  assert.match(repository, /FROZEN_EVIDENCE_CHANGED/);
  assert.match(service, /createProfileCandidateSnapshot/);
  assert.match(repository, /Frozen read dispositions do not exactly reproduce the full preview projection/);
  assert.match(repository, /SAVEPOINT reid_v2_conversion_batch_work/);
  assert.doesNotMatch(repository, /recordBatchFailure/);
  assert.match(repository, /newer\.id > runs\.id/);
  assert.match(repository, /jobs\.stage = 'project_reads'/);
  assert.doesNotMatch(panel, />\s*(Accept|Materialize|Cut over)\b/i);
  assert.doesNotMatch(actions, /acceptVehicleReidV2Conversion|materializeVehicleReidV2/i);
});

test("authoritative exact-plate assignments require reviewed trustworthy plate evidence", () => {
  const assignments = tableBlock("vehicle_reid_v2_read_assignments");
  const dispositions = tableBlock("vehicle_reid_v2_conversion_read_dispositions");
  assert.match(
    assignments,
    /assignment_basis <> 'exact_effective_plate'[\s\S]*normalized_effective_plate IS NOT NULL[\s\S]*plate_review_status IN \('confirmed','corrected','alias_resolved'\)/
  );
  assert.doesNotMatch(dispositions, /plate_review_status/);
  assert.match(
    stage1,
    /FOREIGN KEY \(origin_conversion_run_id, origin_projection_key\)[\s\S]*conversion_projected_profiles/
  );
  assert.match(stage1, /validate_vehicle_reid_v2_profile_contract/);
  assert.match(stage1, /validate_vehicle_reid_v2_member_contract/);
  assert.match(stage1, /validate_vehicle_reid_v2_assignment_contract/);
  assert.match(stage1, /vehicle_reid_v2_assignment_plate_profile_contract/);
  assert.match(stage1, /guard_vehicle_reid_v2_origin_authority_mutation/);
  assert.match(stage1, /sealed outside running\/materialize/);
  assert.match(stage1, /vehicle_reid_v2_conversion_initial_state/);
  assert.match(
    stage1,
    /vehicle_reid_v2_conversion_validate_transition[\s\S]*BEFORE INSERT OR UPDATE/
  );
  assert.match(stage1, /idx_reid_v2_candidate_run_conversion_contract/);
  assert.match(stage1, /vehicle_reid_v2_conversion_candidate_contract/);
  assert.match(stage1, /assert_vehicle_reid_v2_exact_materialization/);
  assert.match(
    stage1,
    /OLD\.status = 'running'[\s\S]*NEW\.status = 'completed'[\s\S]*assert_vehicle_reid_v2_exact_materialization\(OLD\.id\)/
  );
  assert.match(
    stage1,
    /NEW\.mode = 'v2_primary'[\s\S]*assert_vehicle_reid_v2_exact_materialization/
  );
  assert.match(stage1, /vehicle_reid_v2_exact_profile_materialization/);
  assert.match(stage1, /vehicle_reid_v2_exact_member_materialization/);
  assert.match(stage1, /vehicle_reid_v2_exact_assignment_materialization/);
  assert.match(stage1, /validate_vehicle_reid_control_transition/);
  assert.match(stage1, /vehicle_reid_control_singleton_immutable/);
  assert.match(
    stage1,
    /vehicle_reid_control_validate_transition[\s\S]*BEFORE INSERT OR UPDATE OR DELETE/
  );
  assert.match(stage1, /v2_primary requires one completed, exactly revalidated conversion run/);
});

test("server actions and disposable PostgreSQL gate enforce the preview boundary", () => {
  for (const action of [
    "startVehicleReidV2ConversionPreview",
    "processVehicleReidV2ConversionPreviewBatch",
    "setVehicleReidV2ConversionPreviewPaused",
    "cancelVehicleReidV2ConversionPreview",
    "retryVehicleReidV2ConversionPreviewJob",
    "verifyVehicleReidV2ConversionPreview",
  ]) {
    assert.match(actions, new RegExp(`export async function ${action}`));
  }
  assert.match(actions, /requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /requirePermission\("system\.manage_settings"\)/);
  assert.match(postgresGate, /codex_integration_test_guard/);
  assert.match(postgresGate, /vehicle-reid-v2-authoritative-stage1:v1/);
  assert.match(postgresGate, /codex_vehicle_reid_v2_\[0-9a-f\]/);
  assert.match(postgresGate, /new VehicleReidV2ConversionRepository\(\{ pool \}\)/);
  assert.match(postgresGate, /Promise\.all\(requests\)/);
  assert.match(postgresGate, /CODEX_REVALIDATION_FAILURE/);
  assert.match(postgresGate, /BRG999/);
  assert.match(postgresGate, /ambiguous_effective_plates/);
  assert.match(postgresGate, /display_only_fallback/);
  assert.match(postgresGate, /missing_current_crop|incompleteReadId/);
  assert.match(postgresGate, /NIGHTTIME/);
  assert.match(postgresGate, /FROZEN_EVIDENCE_CHANGED|operation\.current, false/);
  assert.match(postgresGate, /SAVEPOINT empty_authority_check/);
  assert.match(postgresGate, /SAVEPOINT partial_authority_check/);
  assert.match(postgresGate, /SAVEPOINT inconsistent_metrics_check/);
  assert.match(postgresGate, /SAVEPOINT sealed_authority_check/);
  assert.match(postgresGate, /SAVEPOINT unrelated_trusted_plate_check/);
  assert.match(postgresGate, /SAVEPOINT direct_completed_insert_check/);
  assert.match(postgresGate, /SAVEPOINT delete_control_check/);
  assert.match(postgresGate, /const dedicatedRunId/);
  assert.match(postgresGate, /v1_rollback/);
  assert.match(postgresGate, /DELETE FROM public\.plate_reads/);
  assert.match(workflow, /codex_vehicle_reid_v2_1a2b3c4d/);
  assert.match(workflow, /DROP DATABASE IF EXISTS \$\{reid_database\} WITH \(FORCE\)/);
  assert.match(workflow, /psql_database "\$reid_database" --file \/workspace\/migrations\.sql[\s\S]*psql_database "\$reid_database" --file \/workspace\/migrations\.sql/);
  assert.match(workflow, /yarn test:vehicle-reid-v2-authoritative:postgres/);
});
