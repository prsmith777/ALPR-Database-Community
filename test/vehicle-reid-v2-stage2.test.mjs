import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  VehicleReidV2AuthorityRepository,
  vehicleReidV2AuthorityRepositoryInternals,
} from "../lib/vehicle-reid-v2-authority-repository.mjs";
import { VehicleReidV2AuthorityService } from "../lib/vehicle-reid-v2-authority-service.mjs";
import {
  VehicleReidV2LiveRepository,
  VehicleReidV2LiveService,
  vehicleReidV2LiveInternals,
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
  const [repository, migration, actions, panel, runtime] = await Promise.all([
    source("lib/vehicle-reid-v2-authority-repository.mjs"),
    source("migrations.sql"),
    source("app/actions.js"),
    source("components/settings/VehicleReidV2ConversionPanel.jsx"),
    source("lib/vehicle-reid-v2-live-runtime.mjs"),
  ]);
  assert.match(repository, /liveProjection\(client, run\)/);
  assert.match(repository, /assertProjectionCurrent/);
  assert.match(repository, /SET LOCAL plan_cache_mode = 'force_custom_plan'/);
  assert.match(repository, /SET LOCAL lock_timeout = '15s'/);
  assert.match(repository, /SET LOCAL statement_timeout = '10min'/);
  const modeTransition = repository.slice(
    repository.indexOf("async transitionMode"),
    repository.indexOf("async mergeProfilesByReview")
  );
  assert.match(modeTransition, /SET LOCAL lock_timeout = '15s'/);
  assert.match(modeTransition, /SET LOCAL statement_timeout = '15s'/);
  assert.match(runtime, /await repository\.fencePredecessorAuthoritySessions\(\)/);
  assert.match(runtime, /Authoritative ReID startup authority fence complete/);
  assert.ok(
    runtime.indexOf("await repository.fencePredecessorAuthoritySessions()")
      < runtime.indexOf("new VehicleReidV2LiveWorker")
  );
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
  const transitionAction = actions.slice(
    actions.indexOf("export async function transitionVehicleReidAuthorityMode"),
    actions.indexOf("export async function getVehicleReidProfiles")
  );
  assert.match(transitionAction, /authorityOverview: authority\.overview/);
  assert.doesNotMatch(transitionAction, /loadVehicleReidV2OperatorOverview\(\)/);
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

test("live startup fences only bounded older sessions holding exact ReID authority locks", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT DISTINCT locks.pid") && sql.includes("ORDER BY locks.pid")) {
        return { rows: [{ pid: 4102 }] };
      }
      if (sql.includes("pg_catalog.pg_terminate_backend")) {
        return { rows: [{ candidate_count: 1, terminated_count: 1 }] };
      }
      if (sql.includes("remaining_count")) return { rows: [{ remaining_count: 0 }] };
      return { rows: [] };
    },
    release() { calls.push({ sql: "RELEASE", params: [] }); },
  };
  const repository = new VehicleReidV2LiveRepository({
    pool: {
      query: async () => ({ rows: [] }),
      connect: async () => client,
    },
  });

  const result = await repository.fencePredecessorAuthoritySessions();
  assert.deepEqual(result, { candidateCount: 1, terminatedCount: 1, remainingCount: 0 });
  assert.deepEqual(calls.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(" ")), [
    "BEGIN",
    "SET LOCAL lock_timeout",
    "SET LOCAL statement_timeout",
    "WITH current_backend AS",
    "WITH current_backend AS",
    "WITH target_locks AS",
    "COMMIT",
    "RELEASE",
  ]);
  const holderCall = calls.find(({ sql }) => sql.includes("ORDER BY locks.pid"));
  assert.deepEqual(holderCall.params, [
    ["vehicle_reid_v2_authority_stage2", "vehicle_reid_v2_authority_stage2_epoch_2"],
    5,
  ]);
  assert.match(holderCall.sql, /activity\.backend_start < current_backend\.backend_start/);
  assert.match(holderCall.sql, /locks\.pid <> pg_catalog\.pg_backend_pid\(\)/);
  assert.match(holderCall.sql, /locks\.locktype = 'advisory'/);
  assert.match(holderCall.sql, /locks\.objsubid = 1/);
  assert.match(holderCall.sql, /activity\.usename = session_user/);
  assert.match(holderCall.sql, /activity\.backend_type = 'client backend'/);
  assert.doesNotMatch(holderCall.sql, /locks\.granted = TRUE/);
  const terminateCall = calls.find(({ sql }) => sql.includes("pg_catalog.pg_terminate_backend"));
  assert.deepEqual(terminateCall.params, [
    ["vehicle_reid_v2_authority_stage2", "vehicle_reid_v2_authority_stage2_epoch_2"],
    [4102],
  ]);
  assert.match(terminateCall.sql, /pg_catalog\.pg_terminate_backend\(pid, 5000\)/);
  assert.match(terminateCall.sql, /activity\.backend_start < current_backend\.backend_start/);
  assert.doesNotMatch(terminateCall.sql, /locks\.granted = TRUE/);
});

test("live startup refuses an unexpectedly broad authority-session fence", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("SELECT DISTINCT locks.pid")) {
        return { rows: [1, 2, 3, 4, 5].map((pid) => ({ pid })) };
      }
      return { rows: [] };
    },
    release() { calls.push("RELEASE"); },
  };
  const repository = new VehicleReidV2LiveRepository({
    pool: {
      query: async () => ({ rows: [] }),
      connect: async () => client,
    },
  });

  await assert.rejects(
    repository.fencePredecessorAuthoritySessions(),
    (error) => error?.code === "VEHICLE_REID_V2_AUTHORITY_FENCE_REFUSED"
  );
  assert.equal(calls.some((sql) => String(sql).includes("pg_catalog.pg_terminate_backend")), false);
  assert.ok(calls.includes("ROLLBACK"));
  assert.ok(calls.includes("RELEASE"));
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

test("authority mode uses the direct control lookup without loading overview counts", async () => {
  const [actions, serviceSource] = await Promise.all([
    source("app/actions.js"),
    source("lib/vehicle-reid-v2-authority-service.mjs"),
  ]);
  const action = actions.slice(
    actions.indexOf("export async function getVehicleReidAuthorityMode()"),
    actions.indexOf("export async function getVehicleReidReviewOverview()")
  );
  assert.match(action, /getVehicleReidV2AuthorityService\(\)\)\.getControl\(\)/);
  assert.doesNotMatch(action, /getOverview\(\)/);
  assert.match(serviceSource, /async getControl\(\)[\s\S]*this\.repository\.getControl\(\)/);

  const calls = [];
  const service = new VehicleReidV2AuthorityService({
    repository: {
      async getControl() {
        calls.push("control");
        return { mode: "v2_primary", revision: "3" };
      },
      async getOverview() {
        calls.push("overview");
        throw new Error("overview must not be loaded");
      },
    },
  });
  assert.deepEqual(await service.getControl(), {
    mode: "v2_primary",
    previousMode: null,
    revision: 3,
    transitionRunId: null,
    transitionReason: null,
    transitionedAt: null,
  });
  assert.deepEqual(calls, ["control"]);
});

test("authoritative profile browsing fences exact-current evidence with physical row ids", async () => {
  const serviceSource = await source("lib/vehicle-reid-v2-authority-service.mjs");
  const serviceListProfiles = serviceSource.slice(
    serviceSource.indexOf("async listProfiles(input = {})"),
    serviceSource.indexOf("async getProfile(profileId)")
  );
  assert.match(serviceListProfiles, /Promise\.all\(\[/);
  assert.match(serviceListProfiles, /this\.repository\.listProfiles\(input\)/);
  assert.match(serviceListProfiles, /this\.getOverview\(\)/);

  const queries = [];
  const repository = new VehicleReidV2AuthorityRepository({
    executor: {
      async query(sql, values) {
        queries.push({ sql, values });
        if (/FROM public\.vehicle_reid_v2_profiles profiles[\s\S]*ORDER BY profiles\.updated_at/.test(sql)) {
          return {
            rows: [
              {
                id: 20, status: "provisional", revision: 1,
                provenance_basis: "provisional_singleton",
                representative_derivative_id: 200,
                created_at: "created-20", updated_at: "updated-20",
              },
              {
                id: 10, status: "active", revision: 2,
                provenance_basis: "mixed", representative_derivative_id: 100,
                created_at: "created-10", updated_at: "updated-10",
              },
            ],
          };
        }
        if (/FROM public\.vehicle_reid_v2_profile_merges merges/.test(sql)) {
          return { rows: [{ id: 900 }] };
        }
        if (/FROM public\.vehicle_reid_v2_current_profile_merges merges/.test(sql)) {
          return { rows: [{ id: 900, source_profile_id: 20, target_profile_id: 10 }] };
        }
        if (/SELECT anchors\.id[\s\S]*FROM public\.vehicle_reid_v2_profile_plate_anchors anchors[\s\S]*ILIKE/.test(sql)) {
          return { rows: [{ id: 301 }] };
        }
        if (/SELECT DISTINCT anchors\.canonical_profile_id/.test(sql)) {
          return { rows: [{ canonical_profile_id: 10 }] };
        }
        if (/FROM public\.vehicle_reid_v2_profile_members members/.test(sql)) {
          return { rows: [{ id: 101 }, { id: 102 }] };
        }
        if (/FROM public\.vehicle_reid_v2_read_assignments assignments/.test(sql)) {
          return { rows: [
            { profile_id: 10, read_id: 201 },
            { profile_id: 20, read_id: 201 },
            { profile_id: 20, read_id: 202 },
            { profile_id: 20, read_id: 203 },
          ] };
        }
        if (/FROM public\.vehicle_reid_v2_profile_plate_anchors anchors/.test(sql)) {
          return { rows: [{ id: 301 }] };
        }
        if (/page_exact_members AS MATERIALIZED/.test(sql)) {
          return { rows: [
            { canonical_profile_id: 10, member_count: 2, representative_storage_path: "10.jpg" },
          ] };
        }
        if (/current_plate_anchors/.test(sql)) {
          return { rows: [{ canonical_profile_id: 10, anchor_count: 1, anchor_plates: ["ABC123"] }] };
        }
        return { rows: [] };
      },
    },
  });

  const page = await repository.listProfiles({ page: 1, pageSize: 24 });
  assert.equal(queries.length, 8);
  assert.deepEqual(queries[0].values, []);
  assert.doesNotMatch(queries[0].sql, /vehicle_reid_v2_current_/);
  assert.doesNotMatch(queries[0].sql, /ILIKE/);
  const rawMerge = queries.find(({ sql }) => (
    /FROM public\.vehicle_reid_v2_profile_merges merges/.test(sql)
  ));
  const exactMerge = queries.find(({ sql }) => (
    /FROM public\.vehicle_reid_v2_current_profile_merges merges/.test(sql)
  ));
  assert.deepEqual(rawMerge.values, [[20, 10]]);
  assert.match(rawMerge.sql, /merges\.status = 'current'[\s\S]*source_profile_id = ANY/);
  assert.deepEqual(exactMerge.values, [[900], [20, 10]]);
  assert.match(exactMerge.sql, /merges\.id = ANY\(\$1::bigint\[\]\)/);

  const rawMembers = queries.find(({ sql }) => (
    /FROM public\.vehicle_reid_v2_profile_members members/.test(sql)
  ));
  const rawAssignments = queries.find(({ sql }) => (
    /FROM public\.vehicle_reid_v2_read_assignments assignments/.test(sql)
  ));
  const rawAnchors = queries.find(({ sql }) => (
    /FROM public\.vehicle_reid_v2_profile_plate_anchors anchors/.test(sql)
  ));
  for (const query of [rawMembers, rawAssignments, rawAnchors]) {
    assert.deepEqual(query.values, [[10, 20]]);
  }
  const exactMembers = queries.find(({ sql }) => /page_exact_members AS MATERIALIZED/.test(sql));
  const exactAnchors = queries.find(({ sql }) => /current_plate_anchors/.test(sql));
  assert.deepEqual(exactMembers.values, [[101, 102], [10], [20], [10]]);
  assert.deepEqual(exactAnchors.values, [[301], [10]]);
  assert.match(exactMembers.sql, /exact_members\.id = ANY\(\$1::bigint\[\]\)[\s\S]*OFFSET 0/);
  assert.doesNotMatch(exactMembers.sql, /FROM UNNEST\(\$1::bigint\[\]\)|JOIN LATERAL/);
  assert.match(exactMembers.sql, /vehicle_reid_v2_exact_profile_members/);
  assert.equal(
    (exactMembers.sql.match(/vehicle_reid_v2_exact_profile_members/g) || []).length,
    1
  );
  assert.match(exactMembers.sql, /conflicting_anchor_members AS MATERIALIZED/);
  assert.match(exactMembers.sql, /conflicting_review_profiles AS MATERIALIZED/);
  assert.match(
    exactMembers.sql,
    /JOIN page_exact_members low_members[\s\S]*JOIN page_exact_members high_members/
  );
  assert.doesNotMatch(exactMembers.sql, /vehicle_reid_v2_current_profile_members/);
  assert.match(exactAnchors.sql, /page_anchors AS MATERIALIZED/);
  assert.match(exactAnchors.sql, /anchors\.id = ANY\(\$1::bigint\[\]\)/);
  assert.match(exactAnchors.sql, /anchors\.canonical_profile_id = ANY\(\$2::bigint\[\]\)/);
  assert.match(exactAnchors.sql, /OFFSET 0/);
  assert.doesNotMatch(exactAnchors.sql, /UNNEST|JOIN LATERAL/);
  assert.equal(queries.filter(({ sql }) => /current_read_assignments/.test(sql)).length, 0);
  assert.match(rawAssignments.sql, /SELECT assignments\.profile_id, assignments\.read_id/);
  assert.deepEqual(page.rows.map((row) => ({
    id: row.id,
    status: row.status,
    members: row.member_count,
    reads: row.read_count,
    anchors: row.anchor_plates,
  })), [
    { id: 10, status: "active", members: 2, reads: 3, anchors: ["ABC123"] },
  ]);
  assert.equal(page.total, 1);

  queries.length = 0;
  await repository.listProfiles({ page: 1, pageSize: 12, search: " ABC123 " });
  assert.equal(queries.length, 10);
  const rawSearch = queries.find(({ sql }) => (
    /FROM public\.vehicle_reid_v2_profile_plate_anchors anchors[\s\S]*ILIKE/.test(sql)
  ));
  const exactSearch = queries.find(({ sql }) => /SELECT DISTINCT anchors\.canonical_profile_id/.test(sql));
  assert.deepEqual(rawSearch.values, [[20, 10], "ABC123"]);
  assert.deepEqual(exactSearch.values, [[301], [20, 10], "ABC123"]);
  assert.match(exactSearch.sql, /anchors\.id = ANY\(\$1::bigint\[\]\)/);
});

test("profile browsing skips exact-current views when indexed physical candidates are empty", async () => {
  const queries = [];
  const repository = new VehicleReidV2AuthorityRepository({
    executor: {
      async query(sql, values) {
        queries.push({ sql, values });
        if (/FROM public\.vehicle_reid_v2_profiles profiles[\s\S]*ORDER BY profiles\.updated_at/.test(sql)) {
          return { rows: [{ id: 10, status: "active", revision: 1 }] };
        }
        return { rows: [] };
      },
    },
  });

  await repository.listProfiles({ page: 1, pageSize: 24 });
  assert.equal(queries.length, 5);
  assert.equal(queries.filter(({ sql }) => /vehicle_reid_v2_current_/.test(sql)).length, 0);
  assert.equal(queries.filter(({ sql }) => (
    /FROM public\.vehicle_reid_v2_(profile_merges|profile_members|read_assignments|profile_plate_anchors)/.test(sql)
  )).length, 4);
});

test("a raw current merge candidate must still pass the exact-current merge view", async () => {
  const queries = [];
  const repository = new VehicleReidV2AuthorityRepository({
    executor: {
      async query(sql, values) {
        queries.push({ sql, values });
        if (/FROM public\.vehicle_reid_v2_profile_merges merges/.test(sql)) {
          return { rows: [{ id: 900 }] };
        }
        if (/FROM public\.vehicle_reid_v2_current_profile_merges merges/.test(sql)) {
          return { rows: [] };
        }
        throw new Error(`Unexpected merge validation query: ${sql}`);
      },
    },
  });

  assert.deepEqual(await repository.listCurrentProfileMergesBySource([20]), []);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].values, [[20]]);
  assert.deepEqual(queries[1].values, [[900], [20]]);
});

test("authoritative profile detail validates merge and evidence candidates by physical id", async () => {
  const queries = [];
  const repository = new VehicleReidV2AuthorityRepository({
    executor: {
      async query(sql, values) {
        queries.push({ sql, values });
        if (/detail_exact_members AS MATERIALIZED/.test(sql)) {
          return { rows: [{
            members: [
              { id: 100, profile_id: 10, canonical_profile_id: 10 },
              { id: 200, profile_id: 20, canonical_profile_id: 10 },
            ],
            reads: [{ id: 300, read_id: 30, profile_id: 20, canonical_profile_id: 10 }],
            read_count: 1,
            anchor_count: 1,
            anchor_plates: ["ABC123"],
            merge_contract_current: true,
          }] };
        }
        if (/FROM public\.vehicle_reid_v2_profile_merges merges[\s\S]*source_profile_id/.test(sql)) {
          return { rows: [{ id: 900 }] };
        }
        if (/FROM public\.vehicle_reid_v2_profile_merges merges[\s\S]*target_profile_id/.test(sql)) {
          return { rows: [{ id: 900 }] };
        }
        if (/FROM public\.vehicle_reid_v2_current_profile_merges merges/.test(sql)) {
          return { rows: [{ id: 900, source_profile_id: 20, target_profile_id: 10 }] };
        }
        if (/SELECT profiles\.\*[\s\S]*WHERE profiles\.id = \$1/.test(sql)) {
          return { rows: [{ id: 10, status: "provisional", revision: 1 }] };
        }
        if (/FROM public\.vehicle_reid_v2_profile_members members/.test(sql)) {
          return { rows: [{ id: 100 }, { id: 200 }] };
        }
        if (/FROM public\.vehicle_reid_v2_read_assignments assignments/.test(sql)) {
          return { rows: [{ id: 300 }] };
        }
        if (/FROM public\.vehicle_reid_v2_profile_plate_anchors anchors/.test(sql)) {
          return { rows: [{ id: 400 }] };
        }
        return { rows: [] };
      },
    },
  });

  const detail = await repository.getProfile(20);
  assert.equal(queries.length, 9);
  const rawSourceMerge = queries.find(({ sql }) => (
    /FROM public\.vehicle_reid_v2_profile_merges merges[\s\S]*source_profile_id/.test(sql)
  ));
  const rawTargetMerge = queries.find(({ sql }) => (
    /FROM public\.vehicle_reid_v2_profile_merges merges[\s\S]*target_profile_id/.test(sql)
  ));
  assert.deepEqual(rawSourceMerge.values, [[20]]);
  assert.deepEqual(rawTargetMerge.values, [[10]]);
  const exactMerges = queries.filter(({ sql }) => (
    /current_profile_merges/.test(sql) && !/detail_exact_members/.test(sql)
  ));
  assert.equal(exactMerges.length, 2);
  assert.deepEqual(exactMerges[0].values, [[900], [20]]);
  assert.deepEqual(exactMerges[1].values, [[900], [10]]);

  const evidenceQuery = queries.find(({ sql }) => /detail_exact_members AS MATERIALIZED/.test(sql));
  assert.deepEqual(evidenceQuery.values, [
    [100, 200], 10, [900], [20], [10], [300], [400], 20,
  ]);
  assert.match(evidenceQuery.sql, /current_merges AS MATERIALIZED[\s\S]*vehicle_reid_v2_current_profile_merges/);
  assert.match(evidenceQuery.sql, /merge_contract AS MATERIALIZED[\s\S]*EXCEPT[\s\S]*UNION ALL[\s\S]*EXCEPT/);
  assert.match(evidenceQuery.sql, /vehicle_reid_v2_exact_profile_members exact_members[\s\S]*exact_members\.id = ANY\(\$1::bigint\[\]\)/);
  assert.doesNotMatch(evidenceQuery.sql, /vehicle_reid_v2_current_profile_members|vehicle_reid_v2_current_read_assignments/);
  assert.doesNotMatch(evidenceQuery.sql, /FROM UNNEST\(\$1::bigint\[\]\)|JOIN LATERAL/);
  assert.equal((evidenceQuery.sql.match(/vehicle_reid_v2_exact_profile_members/g) || []).length, 1);
  assert.match(evidenceQuery.sql, /JOIN detail_exact_members low_members[\s\S]*JOIN detail_exact_members high_members/);
  assert.match(evidenceQuery.sql, /FROM detail_members members[\s\S]*members\.id = assignments\.profile_member_id/);
  assert.match(evidenceQuery.sql, /assignments\.assignment_basis = 'exact_effective_plate'[\s\S]*assignment_reads\.review_revision = assignments\.plate_review_revision[\s\S]*FROM detail_anchors anchors/);
  assert.match(evidenceQuery.sql, /links\.source_path_snapshot[\s\S]*IS NOT DISTINCT FROM assignments\.source_updated_at[\s\S]*assignment_reads\.vehicle_image_updated_at/);
  assert.match(evidenceQuery.sql, /detail_read_rows AS MATERIALIZED[\s\S]*ORDER BY reads\.timestamp DESC, reads\.id DESC[\s\S]*LIMIT 250/);
  assert.match(evidenceQuery.sql, /SELECT JSONB_AGG\(DISTINCT JSONB_BUILD_OBJECT\([\s\S]*FROM public\.plate_tags plate_tags[\s\S]*plate_tags\.plate_number = reads\.plate_number/);
  assert.equal(detail.profile.id, 10);
  assert.equal(detail.profile.effective_status, "active");
  assert.equal(detail.profile.member_count, 2);
  assert.equal(detail.profile.read_count, 1);
  assert.deepEqual(detail.profile.anchor_plates, ["ABC123"]);
  assert.deepEqual(detail.members.map((row) => row.id), [100, 200]);
  assert.deepEqual(detail.reads.map((row) => row.read_id), [30]);
});

test("authoritative profile detail fails closed when its merge contract changes", async () => {
  const repository = new VehicleReidV2AuthorityRepository({
    executor: {
      async query(sql) {
        if (/SELECT profiles\.\*/.test(sql)) {
          return { rows: [{ id: 10, status: "active", revision: 1 }] };
        }
        if (/detail_exact_members AS MATERIALIZED/.test(sql)) {
          return { rows: [{
            members: [], reads: [], read_count: 0, anchor_count: 0,
            anchor_plates: [], merge_contract_current: false,
          }] };
        }
        return { rows: [] };
      },
    },
  });
  repository.listCurrentProfileMergesBySource = async () => [];
  repository.listCurrentProfileMergesByTarget = async () => [];
  repository.listPhysicalProfileEvidenceIds = async () => ({
    memberIds: [], assignmentIds: [], anchorIds: [],
  });

  await assert.rejects(
    repository.getProfile(10),
    (error) => error?.code === "VEHICLE_REID_V2_PROFILE_CHANGED"
  );
});

test("live processor is deterministic, bounded, and never uses cosine as identity", async () => {
  const live = await source("lib/vehicle-reid-v2-live.mjs");
  assert.match(live, /MAX_BATCH_SIZE = 25/);
  assert.match(live, /SET LOCAL lock_timeout = '\$\{LIVE_TRANSACTION_LOCK_TIMEOUT\}'/);
  assert.match(live, /SET LOCAL statement_timeout = '\$\{LIVE_TRANSACTION_STATEMENT_TIMEOUT\}'/);
  assert.ok(
    live.indexOf("SET LOCAL statement_timeout") < live.indexOf("SELECT pg_advisory_xact_lock"),
    "the live statement deadline must be active before the authority lock is acquired"
  );
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

test("authority session locks retain post-lock snapshots and have a bounded wait", async () => {
  assert.equal(
    vehicleReidV2AuthorityRepositoryInternals.AUTHORITY_LOCK,
    vehicleReidV2LiveInternals.LIVE_AUTHORITY_LOCK
  );
  assert.equal(
    vehicleReidV2AuthorityRepositoryInternals.AUTHORITY_LOCK,
    "vehicle_reid_v2_authority_stage2_epoch_2"
  );
  const events = [];
  const client = {
    async query(sql) {
      events.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release() { events.push("release"); },
  };
  const repository = new VehicleReidV2AuthorityRepository({
    pool: {
      connect() { return client; },
      query(...args) { return client.query(...args); },
    },
  });

  await repository.transaction(async () => {
    events.push("operation");
  }, { isolation: "REPEATABLE READ", sessionLock: "test-authority-lock" });

  assert.deepEqual(events, [
    "SET lock_timeout = '15s'",
    "SELECT pg_advisory_lock(hashtext($1))",
    "RESET lock_timeout",
    "BEGIN ISOLATION LEVEL REPEATABLE READ",
    "operation",
    "COMMIT",
    "SELECT pg_advisory_unlock(hashtext($1))",
    "release",
  ]);
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
  let claimCount = 0;
  const repository = {
    async discover() { calls.push("discover"); return [11, 12]; },
    async claim({ limit }) {
      calls.push(`claim:${limit}`);
      claimCount += 1;
      return claimCount === 1
        ? { token: "first-token", readIds: [11, 12] }
        : { token: "second-token", readIds: [] };
    },
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
  assert.deepEqual(calls, [
    "claim:5", "claim:3", "process:11", "process:12", "failure:12",
  ]);
  assert.equal(result.processed, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
});

test("live worker stays in standby off-cutover and drains quickly when primary", async () => {
  let primary = false;
  const limits = [];
  const worker = new VehicleReidV2LiveWorker({
    service: {
      async processBatch({ limit }) {
        limits.push(limit);
        return primary
          ? { mode: "v2_primary", discovered: 1, processed: 1, succeeded: 1, failed: 0 }
          : { mode: "v2_shadow", discovered: 0, processed: 0, succeeded: 0, failed: 0 };
      },
    },
  });
  assert.equal(await worker.runOnce(), 30_000);
  assert.equal(worker.snapshot().phase, "standby");
  primary = true;
  assert.equal(await worker.runOnce(), 2_000);
  assert.equal(worker.snapshot().phase, "working");
  assert.deepEqual(limits, [1, 1]);
});

test("live worker fences exact-current assignment and anchor reads by physical ids", async () => {
  const live = await source("lib/vehicle-reid-v2-live.mjs");
  const assignmentLookup = live.slice(
    live.indexOf("async loadCurrentReadAssignment"),
    live.indexOf("async loadAssetReads")
  );
  assert.match(assignmentLookup, /vehicle_reid_v2_read_assignments historical/);
  assert.match(assignmentLookup, /historical\.read_id = \$1/);
  assert.match(assignmentLookup, /JOIN LATERAL/);
  assert.match(assignmentLookup, /vehicle_reid_v2_current_read_assignments assignments/);
  assert.match(assignmentLookup, /assignments\.id = candidate_ids\.id[\s\S]*OFFSET 0/);

  const anchorInsert = live.slice(
    live.indexOf("async createPlateAnchor"),
    live.indexOf("async createImageAssignment")
  );
  assert.match(anchorInsert, /vehicle_reid_v2_profile_plate_anchors historical/);
  assert.match(anchorInsert, /JOIN LATERAL/);
  assert.match(anchorInsert, /vehicle_reid_v2_current_plate_anchors anchors/);
  assert.match(anchorInsert, /anchors\.id = candidate_ids\.id[\s\S]*OFFSET 0/);

  const imageAssignment = live.slice(
    live.indexOf("async createImageAssignment"),
    live.indexOf("async createPlateAssignment")
  );
  assert.match(imageAssignment, /vehicle_reid_v2_read_assignments historical/);
  assert.match(imageAssignment, /JOIN LATERAL/);
  assert.match(imageAssignment, /vehicle_reid_v2_current_read_assignments assignments/);
  assert.match(imageAssignment, /assignments\.id = candidate_ids\.id[\s\S]*OFFSET 0/);
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
  assert.match(gate, /testBoundedLiveDiscoveryWindows/);
  assert.match(gate, /Promise\.all\(repositories\.map/);
  assert.match(gate, /forced discovery-state rollback/);
  assert.match(gate, /forward_windows_since_revisit = 8/);
  assert.match(gate, /Codex late lower id/);
  assert.match(gate, /authority\.acceptPreview/);
  assert.match(gate, /authority\.materializeAcceptedPreview/);
  assert.match(gate, /mode: "v2_primary"/);
  assert.match(gate, /source-link replacement/);
  assert.match(gate, /row\.status === "ready" && row\.has_current_assignment === true/);
  assert.match(gate, /plate-anchor revision replacement/);
  assert.match(gate, /provisional singleton creation/);
  assert.match(gate, /pre-merge canonical groups/);
  assert.match(gate, /mode: "v1_rollback"/);
  assert.match(gate, /v1_clusters: 1, v1_assignments: 3/);
  assert.match(gate, /vehicle_reid_v2_authoritative_stage2_postgres_gate=passed/);
});
