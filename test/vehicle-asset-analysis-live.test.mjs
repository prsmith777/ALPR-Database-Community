import test from "node:test";
import assert from "node:assert/strict";
import { VehicleAssetAnalysisRepository, VehicleAssetAnalysisService } from "../lib/vehicle-asset-analysis-live.mjs";

function fixture({ enabled = true, source = { derivative_id: 10 }, noJob = false, failure = null } = {}) {
  const calls = [];
  const repository = {
    async isEnabled() { calls.push("enabled"); return enabled; },
    async reclaimExpired() { calls.push("reclaim"); },
    async discover() { calls.push("discover"); },
    async claim() { calls.push("claim"); return noJob ? null : { derivative_id: 10, claim_token: "claim" }; },
    async source(id) { assert.equal(id, 10); calls.push("source"); return source; },
    async finish(job, error) { calls.push(error ? error.code || "failure" : "finish"); },
  };
  const service = new VehicleAssetAnalysisService({
    repository,
    embeddingService: {
      async render() { calls.push("embedding"); return { sha: "validated" }; },
      repository: { async registerEmbedding() { calls.push("save-embedding"); } },
    },
    attributeService: {
      async render() { calls.push("attributes"); if (failure) throw failure; return {}; },
      repository: { async registerObservations() { calls.push("save-attributes"); } },
    },
    directionService: { async backfillDirectionBatch({ limit }) { assert.equal(limit, 5); calls.push("direction"); } },
    wakeIdentity() { calls.push("identity"); },
    logger: { warn() {} },
  });
  return { service, calls, repository };
}

test("native image analysis needs no operator campaign and wakes identity after embedding", async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.processBatch(), { status: "working", phase: "automatic", processed: 1, succeeded: 1, failed: 0 });
  assert.deepEqual(calls, ["enabled", "reclaim", "discover", "claim", "source", "embedding", "save-embedding", "identity", "attributes", "save-attributes", "direction", "finish"]);
});

test("retry resumes after completed stages and does not duplicate immutable evidence", async () => {
  const { service, calls } = fixture({ source: { derivative_id: 10, has_embedding: true, has_attributes: true } });
  await service.processBatch();
  assert.deepEqual(calls.slice(5), ["identity", "direction", "finish"]);
});

test("an attribute failure cannot strand a valid identity embedding", async () => {
  const { service, calls } = fixture({ failure: Object.assign(new Error("private path"), { code: "MODEL_UNAVAILABLE" }) });
  assert.equal((await service.processBatch()).failed, 1);
  assert.ok(calls.indexOf("identity") < calls.indexOf("attributes"));
  assert.equal(calls.at(-1), "MODEL_UNAVAILABLE");
  assert.equal(service.processing, false);
});

test("paused processing does not discover, render, or backfill direction", async () => {
  const { service, calls } = fixture({ enabled: false });
  assert.deepEqual(await service.processBatch(), { status: "paused", processed: 0 });
  assert.deepEqual(calls, ["enabled"]);
});

test("missing or replaced sources never reach an image model", async () => {
  const { service, calls } = fixture({ source: null });
  assert.equal((await service.processBatch()).failed, 1);
  assert.equal(calls.at(-1), "VEHICLE_ANALYSIS_SOURCE_UNAVAILABLE");
  assert.ok(!calls.includes("embedding"));
});

test("idle processing can evaluate newly reviewed camera direction", async () => {
  const { service, calls } = fixture({ noJob: true });
  assert.deepEqual(await service.processBatch(), { status: "idle", processed: 0 });
  assert.equal(calls.at(-1), "direction");
});

test("overlapping ticks do not run duplicate work and discovery failures release the local guard", async () => {
  const { service, repository } = fixture();
  let release;
  repository.isEnabled = () => new Promise(resolve => { release = resolve; });
  const first = service.processBatch();
  assert.deepEqual(await service.processBatch(), { status: "idle", processed: 0 });
  release(false);
  await first;
  repository.isEnabled = async () => { throw new Error("database offline"); };
  await assert.rejects(service.processBatch(), /database offline/);
  assert.equal(service.processing, false);
});

test("analysis leases, exact-source guards, retries and completion are bounded in SQL", async () => {
  const calls = [];
  const repository = new VehicleAssetAnalysisRepository({
    async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; },
  });
  await repository.reclaimExpired();
  await repository.discover();
  await repository.claim();
  await repository.source(10);
  await repository.finish({ derivative_id: 10, claim_token: "token" });
  assert.match(calls[0].sql, /attempt_count >= 3/);
  assert.match(calls[1].sql, /LIMIT 25 ON CONFLICT DO NOTHING/);
  assert.match(calls[1].sql, /identity_eligible/);
  assert.match(calls[1].sql, /relationship <> 'display_fallback'/);
  assert.match(calls[2].sql, /FOR UPDATE SKIP LOCKED LIMIT 1/);
  assert.match(calls[2].sql, /attempt_count < 3/);
  assert.match(calls[3].sql, /derivatives.source_sha256 = assets.content_sha256/);
  assert.match(calls[3].sql, /reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at/);
  assert.match(calls[4].sql, /claim_token = \$2::uuid/);
});

test("processing controls require a known operation and audit in the same transaction", async () => {
  const calls = [];
  const client = { async query(sql, params) { calls.push({ sql, params }); return { rowCount: 2 }; }, release() { calls.push({ sql: "release" }); } };
  const repository = new VehicleAssetAnalysisRepository({ async connect() { return client; } });
  await assert.rejects(repository.operate("delete", 1), /Unknown/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await repository.operate("retry", 5), { changed: 2 });
  assert.equal(calls[0].sql, "BEGIN");
  assert.match(calls[1].sql, /status = 'failed'.*LIMIT 100/s);
  assert.match(calls[2].sql, /audit_events/);
  assert.deepEqual(calls[2].params, [5, '{"operation":"retry","changed":2}']);
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(calls.at(-1).sql, "release");
});

