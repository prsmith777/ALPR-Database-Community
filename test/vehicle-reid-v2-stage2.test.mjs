import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  VehicleReidV2LiveRepository,
  VehicleReidV2LiveService,
} from "../lib/vehicle-reid-v2-live.mjs";
import { VehicleReidV2LiveWorker } from "../lib/vehicle-reid-v2-live-worker.mjs";
import {
  VEHICLE_INTELLIGENCE_LEGACY_NAVIGATION,
  VEHICLE_INTELLIGENCE_PRIMARY_NAVIGATION,
  vehicleIntelligenceNavigationForMode,
} from "../lib/vehicle-intelligence-navigation.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("legacy vehicle source widening is replay-safe after Stage 2 views exist", async () => {
  const migration = await source("migrations.sql");
  const sourceKindWidening = migration.slice(
    migration.indexOf("ADD COLUMN IF NOT EXISTS vehicle_image_source_kind VARCHAR(24)"),
    migration.indexOf("DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_source_kind_check")
  );
  assert.match(sourceKindWidening, /information_schema\.columns/);
  assert.match(sourceKindWidening, /character_maximum_length/);
  assert.match(sourceKindWidening, /IF current_length IS DISTINCT FROM 40 THEN/);
  assert.match(
    sourceKindWidening,
    /ALTER TABLE public\.plate_reads ALTER COLUMN vehicle_image_source_kind TYPE VARCHAR\(40\)/
  );
});

test("Stage 2 schema adds reviewed plate anchors, bounded live jobs, and audited merge aliases", async () => {
  const migration = await source("migrations.sql");
  const stage2 = migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_profile_plate_anchors"));
  assert.match(stage2, /2026081701_vehicle_reid_v2_primary_stage2/);
  assert.match(stage2, /vehicle_reid_v2_profile_plate_anchors/);
  assert.match(stage2, /plate_review_status IN \('confirmed','corrected','alias_resolved'\)/);
  assert.match(stage2, /vehicle_reid_v2_live_jobs/);
  assert.match(stage2, /attempt_count BETWEEN 0 AND 3/);
  assert.match(stage2, /operator_retry_count BETWEEN 0 AND 1/);
  assert.match(stage2, /vehicle_reid_v2_profile_merges/);
  assert.match(stage2, /vehicle_reid_v2_current_profile_merges/);
  assert.match(stage2, /vehicle_reid_v2_exact_profile_members/);
  assert.match(stage2, /vehicle_reid_v2_current_plate_anchors/);
  assert.match(stage2, /vehicle_reid_v2_current_read_assignments/);
  assert.match(stage2, /profile merge history permits only one audited withdrawal/);
  assert.match(stage2, /one exact-current assignment per read/);
  assert.match(stage2, /exact-current audited Same review/);
  assert.match(stage2, /clearly different reviewed plates cannot merge/);
  assert.match(stage2, /low_existing_merge\.target_profile_id, low_member\.profile_id/);
  assert.match(stage2, /low_existing_merge\.id <> merges\.id/);
  assert.match(stage2, /assert_vehicle_reid_v2_stage2_materialization/);
  assert.match(stage2, /vehicle_reid_v2_assignment_plate_profile_contract/);
});

test("accepted materialization revalidates and exactly writes profiles, members, anchors, then assignments", async () => {
  const [repository, migration, actions, panel] = await Promise.all([
    source("lib/vehicle-reid-v2-authority-repository.mjs"),
    source("migrations.sql"),
    source("app/actions.js"),
    source("components/settings/VehicleReidV2ConversionPanel.jsx"),
  ]);
  assert.match(repository, /liveProjection\(client, run\)/);
  assert.match(repository, /assertProjectionCurrent/);
  assert.match(repository, /SET LOCAL plan_cache_mode = 'force_custom_plan'/);
  assert.match(repository, /SET LOCAL lock_timeout = '15s'/);
  assert.match(repository, /SET LOCAL statement_timeout = '10min'/);
  const profileInsert = repository.indexOf("INSERT INTO public.vehicle_reid_v2_profiles");
  const memberInsert = repository.indexOf("INSERT INTO public.vehicle_reid_v2_profile_members");
  const anchorInsert = repository.indexOf("INSERT INTO public.vehicle_reid_v2_profile_plate_anchors");
  const assignmentInsert = repository.indexOf("INSERT INTO public.vehicle_reid_v2_read_assignments");
  assert.ok(profileInsert > 0 && profileInsert < memberInsert && memberInsert < anchorInsert && anchorInsert < assignmentInsert);
  assert.match(repository, /SET status = 'completed', phase = 'complete'/);
  assert.match(repository, /mode = \$1, previous_mode = mode/);
  assert.match(actions, /acceptVehicleReidV2ConversionPreview[\s\S]*requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /materializeVehicleReidV2ConversionPreview[\s\S]*requirePermission\("maintenance\.manage"\)/);
  assert.match(actions, /transitionVehicleReidAuthorityMode[\s\S]*requirePermission\("maintenance\.manage"\)/);
  assert.match(panel, /Accept verified preview/);
  assert.match(panel, /Materialize authoritative ReID/);
  assert.match(panel, /Make ReID v2 primary/);
  assert.match(panel, /Roll back consumers to v1/);

  const scaleFix = migration.slice(
    migration.lastIndexOf("CREATE OR REPLACE FUNCTION public.validate_vehicle_reid_v2_assignment_contract"),
    migration.indexOf("CREATE OR REPLACE VIEW public.vehicle_reid_v2_current_read_assignments")
  );
  const indexedHistoryProbe = scaleFix.indexOf(
    "FROM public.vehicle_reid_v2_read_assignments prior"
  );
  const exactCurrentProbe = scaleFix.indexOf(
    "FROM public.vehicle_reid_v2_current_read_assignments existing"
  );
  assert.ok(indexedHistoryProbe > 0 && indexedHistoryProbe < exactCurrentProbe);
  assert.match(scaleFix, /prior\.read_id = NEW\.read_id/);
  assert.match(scaleFix, /prior\.status = 'active'/);
  assert.match(scaleFix, /\) THEN\s*IF EXISTS \(\s*SELECT 1\s*FROM public\.vehicle_reid_v2_current_read_assignments existing/);
  assert.match(migration, /2026081702_vehicle_reid_v2_materialization_scale/);
});

test("authority overview uses fast stored counts while consumers retain exact-current views", async () => {
  const [repository, panel] = await Promise.all([
    source("lib/vehicle-reid-v2-authority-repository.mjs"),
    source("components/settings/VehicleReidV2ConversionPanel.jsx"),
  ]);
  const overview = repository.slice(
    repository.indexOf("async getOverview()"),
    repository.indexOf("async listProfiles(")
  );
  assert.doesNotMatch(overview, /vehicle_reid_v2_current_/);
  assert.match(overview, /FROM public\.vehicle_reid_v2_profile_members members/);
  assert.match(overview, /FROM public\.vehicle_reid_v2_profile_plate_anchors anchors/);
  assert.match(overview, /FROM public\.vehicle_reid_v2_read_assignments assignments/);
  assert.match(overview, /members\.status = 'current'/);
  assert.match(overview, /anchors\.status = 'current'/);
  assert.match(overview, /assignments\.status = 'active'/);
  assert.match(overview, /COUNT\(DISTINCT assignments\.read_id\)::integer AS assignments/);
  assert.match(overview, /assignment_counts AS MATERIALIZED/);
  assert.doesNotMatch(overview, /stale_assignments/);
  assert.match(panel, /Stored, reconciled authority counts/);
  assert.match(panel, /consumers still revalidate exact current source links, embeddings, and review evidence/);
  assert.match(panel, /label="plate anchors" value=\{authorityCounts\.plateAnchors\}/);
  assert.doesNotMatch(panel, /stale assignments excluded/);
});

test("live processor is deterministic, bounded, and never uses cosine as identity", async () => {
  const live = await source("lib/vehicle-reid-v2-live.mjs");
  assert.match(live, /MAX_BATCH_SIZE = 25/);
  assert.match(live, /mode !== "v2_primary"/);
  assert.match(live, /AMBIGUOUS_EFFECTIVE_PLATES/);
  assert.match(live, /HUMAN_DIFFERENT/);
  assert.match(live, /HUMAN_UNSURE/);
  assert.match(live, /MULTIPLE_AUTHORITATIVE_PROFILES/);
  assert.match(live, /provisional_singleton/);
  assert.match(live, /shared_asset/);
  assert.match(live, /exact_effective_plate/);
  assert.match(live, /relationship <> 'display_fallback'/);
  assert.doesNotMatch(live, /cosine|similarity_score\s*[><=]/i);
  assert.match(live, /FOR UPDATE SKIP LOCKED/);
  assert.match(live, /attempt_count < 3/);
  assert.match(live, /operator_retry_count < 1/);
  assert.match(live, /jobs\.retryable = FALSE[\s\S]*jobs\.attempt_count >= 3/);
  assert.match(live, /ON CONFLICT \(read_id\) DO UPDATE[\s\S]*WHERE public\.vehicle_reid_v2_live_jobs\.status = 'ready'/);
  assert.match(live, /SELECT DISTINCT anchors\.canonical_profile_id AS profile_id[\s\S]*ORDER BY profile_id, anchors\.normalized_plate/);
  assert.match(live, /SELECT \$1, 'current', \$2::varchar\(32\)[\s\S]*anchors\.normalized_plate = \$2::varchar\(32\)/);
  assert.match(live, /id: Number\(candidate\.profile_id\),[\s\S]*revision: Number\(candidate\.profile_revision\)/);
  assert.equal((live.match(/links\.updated_at::text AS source_link_updated_at/g) || []).length, 2);
});

test("live discovery never evaluates candidates while v2 is not primary", async () => {
  const queries = [];
  const repository = new VehicleReidV2LiveRepository({
    pool: {
      connect() { throw new Error("not used"); },
      async query(sql) {
        queries.push(sql);
        return { rows: [{ mode: "v2_shadow" }] };
      },
    },
  });
  assert.deepEqual(await repository.discover({ limit: 25 }), []);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /SELECT mode FROM public\.vehicle_reid_control/);
  assert.doesNotMatch(queries[0], /vehicle_reid_v2_current_read_assignments/);
});

test("live service processes claimed reads and reports failures without abandoning the batch", async () => {
  const calls = [];
  const repository = {
    async discover() { calls.push("discover"); return [11, 12]; },
    async claim() { calls.push("claim"); return { token: "token", readIds: [11, 12] }; },
    async processClaimedRead({ readId }) {
      calls.push(`process:${readId}`);
      if (readId === 12) throw Object.assign(new Error("forced"), { code: "FORCED" });
      return { status: "ready", readId };
    },
    async recordFailure({ readId }) { calls.push(`failure:${readId}`); return { code: "FORCED", message: "forced" }; },
    async getOverview() { return { mode: "v2_primary", pending: 0 }; },
  };
  const service = new VehicleReidV2LiveService({ repository, logger: { error() {} } });
  const result = await service.processBatch({ limit: 5 });
  assert.deepEqual(calls, ["discover", "claim", "process:11", "process:12", "failure:12"]);
  assert.equal(result.processed, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
});

test("live worker stays in standby off-cutover and drains quickly when primary", async () => {
  let primary = false;
  const worker = new VehicleReidV2LiveWorker({
    service: {
      async processBatch() {
        return primary
          ? { mode: "v2_primary", discovered: 1, processed: 1, succeeded: 1, failed: 0 }
          : { mode: "v2_shadow", discovered: 0, processed: 0, succeeded: 0, failed: 0 };
      },
    },
  });
  assert.equal(await worker.runOnce(), 30_000);
  assert.equal(worker.snapshot().phase, "standby");
  primary = true;
  assert.equal(await worker.runOnce(), 250);
  assert.equal(worker.snapshot().phase, "working");
});

test("compatibility routing switches every identity consumer without rewriting plate reads", async () => {
  const [database, table, searchPage, authority, shadowRepository] = await Promise.all([
    source("lib/db.js"),
    source("components/PlateTable.jsx"),
    source("app/visual_search/page.jsx"),
    source("lib/vehicle-reid-v2-authority-repository.mjs"),
    source("lib/vehicle-reid-v2-shadow-repository.mjs"),
  ]);
  assert.match(database, /CASE WHEN reid_control\.mode = 'v2_primary'/);
  assert.match(database, /vehicle_reid_v2_current_read_assignments/);
  assert.match(database, /canonical_profile_id/);
  assert.match(database, /links\.identity_eligible = TRUE/);
  assert.match(database, /links\.relationship <> 'display_fallback'/);
  assert.doesNotMatch(database, /UPDATE\s+public\.plate_reads[\s\S]*vehicle_reid/i);
  assert.match(table, /vehicleIdentityMode === "v2_primary"/);
  assert.match(table, /Find similar vehicle/);
  assert.match(table, /Open Vehicle Profile/);
  assert.match(table, /Find similar unavailable/);
  assert.match(searchPage, /resolveVehicleReidRead/);
  assert.match(searchPage, /currentIdentityLink/);
  assert.match(searchPage, /primaryBrowse: true/);
  assert.match(searchPage, /redirect\(`\/visual_search\/profiles/);
  assert.match(authority, /vehicle_image_asset_reads links/);
  assert.match(authority, /embeddings\.source_sha256 = derivatives\.content_sha256/);
  assert.match(shadowRepository, /vehicle_reid_v2_current_profile_members/);
});

test("navigation is final only in v2 primary and legacy routes remain rollback redirects", async () => {
  assert.equal(vehicleIntelligenceNavigationForMode("v2_primary"), VEHICLE_INTELLIGENCE_PRIMARY_NAVIGATION);
  assert.equal(vehicleIntelligenceNavigationForMode("v1_rollback"), VEHICLE_INTELLIGENCE_LEGACY_NAVIGATION);
  assert.deepEqual(VEHICLE_INTELLIGENCE_PRIMARY_NAVIGATION.map(({ title, href }) => ({ title, href })), [
    { title: "Vehicle Search", href: "/visual_search" },
    { title: "Profiles", href: "/visual_search/profiles" },
    { title: "Review", href: "/visual_search/review" },
  ]);
  const [legacyProfiles, legacyReview, legacyShadow] = await Promise.all([
    source("app/visual_search/vehicles/page.jsx"),
    source("app/visual_search/vehicles/review/page.jsx"),
    source("app/visual_search/reid-v2/page.jsx"),
  ]);
  assert.match(legacyProfiles, /mode === "v2_primary"[\s\S]*redirect\("\/visual_search\/profiles"\)/);
  assert.match(legacyReview, /mode === "v2_primary"[\s\S]*redirect\("\/visual_search\/review"\)/);
  assert.match(legacyShadow, /mode === "v2_primary"[\s\S]*redirect\(`\/visual_search\/review/);
});

test("disposable PostgreSQL gate commits the full Stage 2 lifecycle and retains v1 rollback data", async () => {
  const gate = await source("scripts/test-vehicle-reid-v2-authoritative-postgres.mjs");
  assert.match(gate, /testCommittedStage2MaterializationAndRollback/);
  assert.match(gate, /authority\.acceptPreview/);
  assert.match(gate, /authority\.materializeAcceptedPreview/);
  assert.match(gate, /mode: "v2_primary"/);
  assert.match(gate, /source-link replacement/);
  assert.match(gate, /plate-anchor revision replacement/);
  assert.match(gate, /provisional singleton creation/);
  assert.match(gate, /pre-merge canonical groups/);
  assert.match(gate, /mode: "v1_rollback"/);
  assert.match(gate, /v1_clusters: 1, v1_assignments: 3/);
  assert.match(gate, /vehicle_reid_v2_authoritative_stage2_postgres_gate=passed/);
});
