import test from "node:test";
import assert from "node:assert/strict";
import { hydratePlateReadVehicleIdentity, PRIMARY_PLATE_READ_IDENTITY_SQL } from "../lib/plate-read-vehicle-identity.mjs";
import { withReadOnlySnapshot } from "../lib/read-only-snapshot.mjs";
import { createQueryTiming } from "../lib/query-timing.mjs";

function identityClient(mode, identities = []) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({ sql, params });
    return { rows: calls.length === 1 ? (mode === undefined ? [] : [{ mode }]) : identities };
  } };
}

for (const mode of ["v1_primary", "v1_rollback", "v2_shadow"]) {
  test(mode + " preserves legacy identities without querying authoritative evidence", async () => {
    const client = identityClient(mode, [{ read_id: "20", cluster_id: "7", assignment_status: "assigned", similarity: 0.9 }]);
    const rows = [{ id: 21, marker: "first" }, { id: 20, marker: "second" }];
    const result = await hydratePlateReadVehicleIdentity(client, rows);
    assert.deepEqual(result.map(row => row.id), [21, 20]);
    assert.equal(result[0].marker, "first");
    assert.equal(result[0].vehicle_cluster_id, null);
    assert.equal(result[1].vehicle_cluster_id, "7");
    assert.equal(result[1].vehicle_cluster_status, "assigned");
    assert.equal(result[1].vehicle_cluster_similarity, 0.9);
    assert.ok(result.every(row => row.vehicle_identity_mode === mode && row.vehicle_profile_id === null && row.vehicle_find_similar_available));
    assert.equal(client.calls.length, 2);
    assert.match(client.calls[1].sql, /vehicle_cluster_assignments WHERE read_id = ANY\(\$1::bigint\[\]\)/);
    assert.deepEqual(client.calls[1].params, [[21, 20]]);
    assert.doesNotMatch(client.calls[1].sql, /vehicle_reid_v2|vehicle_asset_embeddings/);
    assert.deepEqual(rows, [{ id: 21, marker: "first" }, { id: 20, marker: "second" }]);
  });
}

test("primary identities preserve row order and never fall back to legacy assignments", async () => {
  const client = identityClient("v2_primary", [
    { read_id: "20", canonical_profile_id: "8", assignment_basis: "exact_effective_plate", searchable: false },
    { read_id: "21", canonical_profile_id: null, assignment_basis: null, searchable: true },
  ]);
  const result = await hydratePlateReadVehicleIdentity(client, [{ id: 21 }, { id: "20" }, { id: 22 }]);
  assert.deepEqual(result.map(row => row.id), [21, "20", 22]);
  assert.equal(result[0].vehicle_cluster_id, null);
  assert.equal(result[0].vehicle_find_similar_available, true);
  assert.equal(result[1].vehicle_cluster_id, "8");
  assert.equal(result[1].vehicle_cluster_status, "authoritative");
  assert.equal(result[1].vehicle_profile_assignment_basis, "exact_effective_plate");
  assert.equal(result[1].vehicle_find_similar_available, false);
  assert.equal(result[2].vehicle_profile_id, null);
  assert.equal(result[2].vehicle_find_similar_available, false);
  assert.ok(result.every(row => row.vehicle_cluster_similarity === null));
  assert.equal(client.calls[1].sql, PRIMARY_PLATE_READ_IDENTITY_SQL);
  assert.deepEqual(client.calls[1].params, [[21, "20", 22]]);
});

test("missing or invalid authority fails closed instead of silently selecting legacy data", async () => {
  for (const mode of [undefined, null, "", "unexpected"]) {
    const client = identityClient(mode);
    await assert.rejects(hydratePlateReadVehicleIdentity(client, [{ id: 1 }]), /authority mode unavailable/);
    assert.equal(client.calls.length, 1);
  }
});

test("empty pages require no identity queries", async () => {
  const client = identityClient("v2_primary");
  const rows = [];
  assert.equal(await hydratePlateReadVehicleIdentity(client, rows), rows);
  assert.equal(client.calls.length, 0);
});

function snapshotPool(failure) {
  const calls = [];
  const client = { async query(sql) {
    calls.push(sql);
    if (sql === failure) throw new Error(failure);
    return { rows: [] };
  }, release() { calls.push("release"); } };
  return { calls, client, async connect() { calls.push("connect"); return client; } };
}

test("feed snapshot uses one read-only repeatable-read client and commits before releasing", async () => {
  const pool = snapshotPool();
  assert.equal(await withReadOnlySnapshot(pool, async client => {
    assert.equal(client, pool.client);
    await client.query("page");
    await client.query("identity");
    return "result";
  }), "result");
  assert.deepEqual(pool.calls, ["connect", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "page", "identity", "COMMIT", "release"]);
});

test("snapshot rolls back on query, begin, or commit failure and always releases", async () => {
  for (const failing of ["page", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT"]) {
    const pool = snapshotPool(failing);
    await assert.rejects(withReadOnlySnapshot(pool, client => client.query("page")), { message: failing });
    assert.deepEqual(pool.calls.slice(-2), ["ROLLBACK", "release"]);
  }
});

test("rollback failure preserves the original error; connection failure never runs work", async () => {
  const pool = snapshotPool("ROLLBACK");
  await assert.rejects(withReadOnlySnapshot(pool, async () => { throw new Error("original"); }), /original/);
  assert.deepEqual(pool.calls.slice(-2), ["ROLLBACK", "release"]);
  await assert.rejects(withReadOnlySnapshot({ connect() { throw new Error("connection"); } },
    () => assert.fail("must not run")), /connection/);
});

test("timings log only slow stage durations, including a failed operation", async () => {
  let now = 0;
  const logs = [];
  const timing = createQueryTiming("feed", { clock: () => now, logger: { info: (...args) => logs.push(args) } });
  await timing.measure("page", async () => { now = 100; return "not logged"; });
  timing.finish();
  assert.equal(logs.length, 0);
  await assert.rejects(timing.measure("identity", async () => { now = 500; throw new Error("not logged"); }));
  timing.finish();
  assert.deepEqual(logs, [["feed", { totalMs: 500, stages: { page: 100, identity: 400 } }]]);
});
