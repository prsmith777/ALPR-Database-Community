import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  VehicleReidV2LiveRepository,
  VehicleReidV2LiveService,
} from "../lib/vehicle-reid-v2-live.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function discoveryHarness({
  state,
  reads = [],
  eligible = () => false,
  failStateUpdate = false,
} = {}) {
  const events = [];
  const committedJobs = [];
  let stagedJobs = [];
  let stagedState = null;

  const client = {
    async query(sql, values = []) {
      if (sql === "BEGIN") {
        events.push("begin");
        stagedJobs = [];
        stagedState = null;
        return { rows: [], rowCount: 0 };
      }
      if (sql === "COMMIT") {
        events.push("commit");
        committedJobs.push(...stagedJobs);
        if (stagedState) Object.assign(state, stagedState);
        return { rows: [], rowCount: 0 };
      }
      if (sql === "ROLLBACK") {
        events.push("rollback");
        stagedJobs = [];
        stagedState = null;
        return { rows: [], rowCount: 0 };
      }
      if (/FOR UPDATE OF state/.test(sql)) {
        events.push("lock-state");
        return {
          rowCount: 1,
          rows: [{
            mode: "v2_primary",
            control_transition_run_id: state.transition_run_id,
            scanned_recently: false,
            last_scanned_at: state.last_scanned_at || null,
            ...state,
          }],
        };
      }
      if (/WHERE reads\.id > \$1[\s\S]*AND reads\.id <= \$2/.test(sql)) {
        events.push("revisit-window");
        const rows = reads
          .filter((id) => id > Number(values[0]) && id <= Number(values[1]))
          .sort((left, right) => left - right)
          .slice(0, Number(values[2]))
          .map((id) => ({ id }));
        return { rows, rowCount: rows.length };
      }
      if (/FROM public\.plate_reads reads[\s\S]*WHERE reads\.id > \$1[\s\S]*LIMIT \$2/.test(sql)) {
        events.push("forward-window");
        const rows = reads
          .filter((id) => id > Number(values[0]))
          .sort((left, right) => left - right)
          .slice(0, Number(values[1]))
          .map((id) => ({ id }));
        return { rows, rowCount: rows.length };
      }
      if (/WITH raw_window AS MATERIALIZED/.test(sql)) {
        events.push("upsert-jobs");
        stagedJobs = values[0].filter((id) => eligible(id));
        return {
          rows: stagedJobs.map((read_id) => ({ read_id })),
          rowCount: stagedJobs.length,
        };
      }
      if (/UPDATE public\.vehicle_reid_v2_live_discovery_state/.test(sql)) {
        events.push("advance-state");
        if (failStateUpdate) return { rows: [], rowCount: 0 };
        stagedState = {
          forward_cursor_read_id: Number(values[0]),
          revisit_cursor_read_id: Number(values[1]),
          revisit_upper_read_id: Number(values[2]),
          revisit_epoch: Number(values[3]),
          forward_windows_since_revisit: Number(values[4]),
          revision: Number(state.revision) + 1,
          last_scanned_at: "now",
        };
        return { rows: [{ revision: stagedState.revision }], rowCount: 1 };
      }
      throw new Error(`Unexpected discovery query: ${sql}`);
    },
    release() {
      events.push("release");
    },
  };

  return {
    events,
    committedJobs,
    repository: new VehicleReidV2LiveRepository({
      pool: {
        connect() { return client; },
        async query(sql) {
          assert.match(sql, /SELECT mode FROM public\.vehicle_reid_control/);
          events.push("mode");
          return { rows: [{ mode: "v2_primary" }], rowCount: 1 };
        },
      },
    }),
  };
}

test("bounded discovery migration persists independent cursors and seeds without rewind", async () => {
  const [migration, live] = await Promise.all([
    source("migrations.sql"),
    source("lib/vehicle-reid-v2-live.mjs"),
  ]);
  const bounded = migration.slice(
    migration.indexOf("CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_live_discovery_state")
  );
  const table = bounded.slice(0, bounded.indexOf(");") + 2);
  assert.match(bounded, /2026081703_vehicle_reid_v2_bounded_live_discovery/);
  assert.match(table, /forward_cursor_read_id INTEGER NOT NULL/);
  assert.match(table, /revisit_cursor_read_id INTEGER NOT NULL/);
  assert.match(table, /revisit_upper_read_id INTEGER NOT NULL/);
  assert.match(table, /revisit_epoch BIGINT NOT NULL/);
  assert.match(table, /forward_windows_since_revisit SMALLINT NOT NULL/);
  assert.match(table, /last_scanned_at TIMESTAMPTZ/);
  assert.match(table, /revision BIGINT NOT NULL/);
  assert.doesNotMatch(table, /forward_cursor_read_id[\s\S]*REFERENCES public\.plate_reads/);
  assert.match(bounded, /JOIN public\.vehicle_reid_v2_conversion_runs runs[\s\S]*runs\.id = control\.transition_run_id/);
  assert.match(bounded, /runs\.status = 'completed'[\s\S]*runs\.phase = 'complete'/);
  assert.match(bounded, /forward_cursor_read_id = GREATEST/);
  assert.match(bounded, /NEW\.forward_cursor_read_id < OLD\.forward_cursor_read_id/);
  assert.match(bounded, /NEW\.revision <> OLD\.revision \+ 1/);
  assert.match(bounded, /last_scanned_at = COALESCE/);
  assert.match(bounded, /OLD\.mode IS DISTINCT FROM NEW\.mode/);
  assert.match(bounded, /last_scanned_at = EXCLUDED\.last_scanned_at/);
  assert.match(live, /MAX_DISCOVERY_WINDOW_SIZE = 250/);
  assert.match(live, /MAX_FORWARD_WINDOWS_BEFORE_REVISIT = 8/);
  assert.match(live, /forward_windows_since_revisit = \$5/);
  assert.match(live, /AND revision = \$6/);
  assert.match(live, /DISCOVERY_DUE_INTERVAL_SECONDS = 30/);
  assert.match(live, /FOR UPDATE OF state/);
  assert.match(live, /WITH raw_window AS MATERIALIZED/);
  assert.match(live, /assignment_candidate_ids AS MATERIALIZED/);
  assert.match(live, /anchor_candidate_ids AS MATERIALIZED/);
});

test("zero-match forward windows still advance atomically to the last raw id", async () => {
  const state = {
    transition_run_id: 9,
    forward_cursor_read_id: 10,
    revisit_cursor_read_id: 10,
    revisit_upper_read_id: 10,
    revisit_epoch: 0,
    revision: 1,
  };
  const harness = discoveryHarness({ state, reads: [11, 12] });
  assert.deepEqual(await harness.repository.discover({ limit: 250 }), []);
  assert.equal(state.forward_cursor_read_id, 12);
  assert.equal(state.revision, 2);
  assert.deepEqual(harness.committedJobs, []);
  assert.ok(harness.events.indexOf("upsert-jobs") < harness.events.indexOf("advance-state"));
  assert.ok(harness.events.indexOf("advance-state") < harness.events.indexOf("commit"));
});

test("job upserts roll back when discovery-state advancement conflicts", async () => {
  const state = {
    transition_run_id: 9,
    forward_cursor_read_id: 10,
    revisit_cursor_read_id: 10,
    revisit_upper_read_id: 10,
    revisit_epoch: 0,
    revision: 1,
  };
  const harness = discoveryHarness({
    state,
    reads: [11],
    eligible: () => true,
    failStateUpdate: true,
  });
  await assert.rejects(
    harness.repository.discover({ limit: 250 }),
    (error) => error?.code === "VEHICLE_REID_V2_DISCOVERY_STATE_CONFLICT"
  );
  assert.equal(state.forward_cursor_read_id, 10);
  assert.deepEqual(harness.committedJobs, []);
  assert.ok(harness.events.includes("rollback"));
  assert.ok(!harness.events.includes("commit"));
});

test("forward priority and an independent revisit epoch catch late lower ids", async () => {
  const state = {
    transition_run_id: 9,
    forward_cursor_read_id: 3,
    revisit_cursor_read_id: 3,
    revisit_upper_read_id: 3,
    revisit_epoch: 0,
    revision: 1,
  };
  const reads = [1, 3, 4];
  const harness = discoveryHarness({ state, reads, eligible: () => true });

  assert.deepEqual(await harness.repository.discover({ limit: 1 }), [4]);
  assert.equal(state.forward_cursor_read_id, 4);
  assert.equal(state.revisit_cursor_read_id, 3);

  assert.deepEqual(await harness.repository.discover({ limit: 1 }), [1]);
  assert.equal(state.revisit_epoch, 1);
  assert.equal(state.revisit_upper_read_id, 4);
  assert.equal(state.revisit_cursor_read_id, 1);

  reads.push(2, 5);
  assert.deepEqual(await harness.repository.discover({ limit: 1 }), [5]);
  assert.equal(state.forward_cursor_read_id, 5);
  assert.equal(state.revisit_cursor_read_id, 1);

  assert.deepEqual(await harness.repository.discover({ limit: 1 }), [2]);
  assert.equal(state.revisit_cursor_read_id, 2);
});

test("persisted fairness services one revisit window during a sustained forward stream", async () => {
  const state = {
    transition_run_id: 9,
    forward_cursor_read_id: 8,
    revisit_cursor_read_id: 1,
    revisit_upper_read_id: 4,
    revisit_epoch: 1,
    forward_windows_since_revisit: 8,
    revision: 1,
  };
  const harness = discoveryHarness({
    state,
    reads: [2, 3, 4, 9, 10],
    eligible: () => true,
  });

  assert.deepEqual(await harness.repository.discover({ limit: 2 }), [2, 3]);
  assert.equal(state.forward_cursor_read_id, 8);
  assert.equal(state.revisit_cursor_read_id, 3);
  assert.equal(state.forward_windows_since_revisit, 0);

  assert.deepEqual(await harness.repository.discover({ limit: 2 }), [9, 10]);
  assert.equal(state.forward_cursor_read_id, 10);
  assert.equal(state.revisit_cursor_read_id, 3);
  assert.equal(state.forward_windows_since_revisit, 1);
});

test("discovery enqueues every eligible read in the fixed 250-id raw window", async () => {
  const state = {
    transition_run_id: 9,
    forward_cursor_read_id: 0,
    revisit_cursor_read_id: 0,
    revisit_upper_read_id: 0,
    revisit_epoch: 0,
    revision: 1,
  };
  const reads = Array.from({ length: 300 }, (_, index) => index + 1);
  const harness = discoveryHarness({ state, reads, eligible: () => true });
  const discovered = await harness.repository.discover({ limit: 10_000 });
  assert.equal(discovered.length, 250);
  assert.deepEqual(discovered, reads.slice(0, 250));
  assert.equal(state.forward_cursor_read_id, 250);
});

test("a claimed read is released across rollback and processed after primary re-entry", async () => {
  let mode = "v2_primary";
  const job = {
    readId: 41,
    status: "pending",
    attemptCount: 0,
    retryable: true,
    claimToken: null,
  };
  const client = {
    async query(sql, values = []) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/^SET LOCAL (lock_timeout|statement_timeout)/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/WITH candidates AS \(/.test(sql)) {
        if (mode !== "v2_primary" || job.status !== "pending" || job.attemptCount >= 3) {
          return { rows: [], rowCount: 0 };
        }
        job.status = "processing";
        job.attemptCount += 1;
        job.retryable = false;
        job.claimToken = values[1];
        return { rows: [{ read_id: job.readId }], rowCount: 1 };
      }
      if (/SELECT mode FROM public\.vehicle_reid_control/.test(sql)) {
        return { rows: [{ mode }], rowCount: 1 };
      }
      if (/SET status = 'pending',[\s\S]*attempt_count = GREATEST/.test(sql)) {
        assert.equal(values[0], job.readId);
        assert.equal(values[1], job.claimToken);
        assert.match(sql, /status = 'processing' AND claim_token = \$2::uuid/);
        job.status = "pending";
        job.attemptCount = Math.max(job.attemptCount - 1, 0);
        job.retryable = true;
        job.claimToken = null;
        return { rows: [{ attempt_count: job.attemptCount }], rowCount: 1 };
      }
      if (/FROM public\.vehicle_reid_v2_current_read_assignments assignments/.test(sql)) {
        return {
          rows: [{ id: 73, profile_id: 17, assignment_basis: "exact_effective_plate" }],
          rowCount: 1,
        };
      }
      if (/SELECT reads\.id AS read_id/.test(sql)) {
        return {
          rows: [{
            read_id: job.readId,
            plate_number: "ROLL41",
            review_status: "unreviewed",
            review_revision: 0,
          }],
          rowCount: 1,
        };
      }
      if (/SET status = \$3/.test(sql)) {
        assert.equal(values[0], job.readId);
        assert.equal(values[1], job.claimToken);
        assert.equal(values[2], "ready");
        job.status = "ready";
        job.claimToken = null;
        return { rows: [{ read_id: job.readId }], rowCount: 1 };
      }
      throw new Error(`Unexpected claim-release query: ${sql}`);
    },
    release() {},
  };
  const repository = new VehicleReidV2LiveRepository({
    pool: {
      connect() { return client; },
      query(...args) { return client.query(...args); },
    },
  });

  const firstClaim = await repository.claim({ limit: 1 });
  assert.deepEqual(firstClaim.readIds, [job.readId]);
  assert.equal(job.attemptCount, 1);

  mode = "v1_rollback";
  assert.deepEqual(
    await repository.processClaimedRead({ readId: job.readId, claimToken: firstClaim.token }),
    { status: "pending", readId: job.readId, released: true, attemptCount: 0 }
  );
  assert.deepEqual(
    { status: job.status, attemptCount: job.attemptCount, retryable: job.retryable, claimToken: job.claimToken },
    { status: "pending", attemptCount: 0, retryable: true, claimToken: null }
  );

  mode = "v2_primary";
  const secondClaim = await repository.claim({ limit: 1 });
  assert.deepEqual(secondClaim.readIds, [job.readId]);
  assert.notEqual(secondClaim.token, firstClaim.token);
  assert.deepEqual(
    await repository.processClaimedRead({ readId: job.readId, claimToken: secondClaim.token }),
    { status: "ready", readId: job.readId, reused: true }
  );
  assert.equal(job.status, "ready");
  assert.equal(job.attemptCount, 1);
});

test("claim-first service skips a fresh scan, scans when due, and always claims again", async () => {
  const calls = [];
  let claims = 0;
  const pendingRepository = {
    async claim({ limit }) {
      calls.push(`claim:${limit}`);
      claims += 1;
      return claims === 1
        ? { token: "first", readIds: [7] }
        : { token: "second", readIds: [] };
    },
    async isDiscoveryDue() { calls.push("due"); return false; },
    async discover() { calls.push("discover"); return []; },
    async processClaimedRead({ readId }) { calls.push(`process:${readId}`); return { status: "ready" }; },
    async getOverview() { return { mode: "v2_primary" }; },
  };
  await new VehicleReidV2LiveService({ repository: pendingRepository }).processBatch({ limit: 5 });
  assert.deepEqual(calls, ["claim:5", "due", "claim:4", "process:7"]);

  calls.length = 0;
  claims = 0;
  pendingRepository.isDiscoveryDue = async () => { calls.push("due"); return true; };
  pendingRepository.discover = async (options) => {
    calls.push(`discover:${options.onlyIfDue}:${options.limit}`);
    return [8];
  };
  await new VehicleReidV2LiveService({ repository: pendingRepository }).processBatch({ limit: 1 });
  assert.deepEqual(calls, ["claim:1", "due", "discover:true:250", "claim:0", "process:7"]);

  calls.length = 0;
  claims = 0;
  pendingRepository.claim = async ({ limit }) => {
    calls.push(`claim:${limit}`);
    claims += 1;
    return claims === 1
      ? { token: "empty", readIds: [] }
      : { token: "after-discovery", readIds: [8] };
  };
  await new VehicleReidV2LiveService({ repository: pendingRepository }).processBatch({ limit: 5 });
  assert.deepEqual(calls, ["claim:5", "discover:false:250", "claim:5", "process:8"]);
});
