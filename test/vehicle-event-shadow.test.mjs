import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  evaluateShadowPair,
  shadowDecisionIdentity,
} from "../lib/vehicle-event-shadow-model.mjs";
import { VehicleEventShadowService } from "../lib/vehicle-event-shadow.mjs";
import { VehicleEventShadowWorker } from "../lib/vehicle-event-shadow-worker.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

function observation(overrides = {}) {
  return {
    read_id: 101,
    asset_id: 901,
    overview_context: "street",
    identity_eligible: true,
    effective_plate: "ABC123",
    read_camera_name: "Street LPR 1",
    read_timestamp: "2026-08-14 19:00:00.123456-06",
    direction_status: "ready",
    direction_label: "Eastbound",
    source_kind: "overview_primary",
    source_path_snapshot: "images/street-101.jpg",
    source_updated_at: "2026-08-14 19:00:01.123456-06",
    captured_at: "2026-08-14 19:00:00.500000-06",
    ...overrides,
  };
}

test("exact shared canonical bytes produce one deterministic shadow pair", () => {
  const anchor = observation();
  const companion = observation({
    read_id: 102,
    read_camera_name: "Street LPR 2",
    read_timestamp: "2026-08-14 19:00:04.000000-06",
    source_kind: "overview_pair_share",
    source_path_snapshot: "images/street-102.jpg",
  });
  const result = evaluateShadowPair(anchor, [companion]);
  assert.equal(result.outcome, "proposed");
  assert.equal(result.reason, "EXACT_SHARED_ASSET");
  assert.equal(result.event.correlationClass, "shared_asset");
  assert.equal(result.event.overviewContext, "street");
  assert.match(result.event.eventIdentity, /^[0-9a-f]{64}$/);
  assert.equal(
    evaluateShadowPair(anchor, [companion]).event.eventIdentity,
    result.event.eventIdentity
  );
  assert.equal(result.event.metadata.externalProviderContacted, false);
});

test("two distinct canonical images require matching direction and capture timing", () => {
  const anchor = observation({ overview_context: "entry", read_camera_name: "Entry LPR 1" });
  const companion = observation({
    read_id: 202,
    asset_id: 902,
    overview_context: "entry",
    read_camera_name: "Entry LPR 2",
    read_timestamp: "2026-08-14 19:00:00.600000-06",
    captured_at: "2026-08-14 19:00:01.200000-06",
    source_kind: "entry_overview_primary",
    source_path_snapshot: "images/entry-202.jpg",
  });
  const result = evaluateShadowPair(anchor, [companion]);
  assert.equal(result.outcome, "proposed");
  assert.equal(result.reason, "CORROBORATED_TIMED_PAIR");
  assert.equal(result.event.correlationClass, "timed_pair");

  assert.equal(evaluateShadowPair(anchor, [{
    ...companion,
    direction_label: "Exiting",
  }]).reason, "CONFLICTING_DIRECTION");
  assert.equal(evaluateShadowPair(anchor, [{
    ...companion,
    direction_status: "unknown",
    direction_label: null,
  }]).reason, "DIRECTION_NOT_CORROBORATED");
  assert.equal(evaluateShadowPair(anchor, [{
    ...companion,
    captured_at: "2026-08-14 19:00:03.000000-06",
  }]).reason, "CAPTURE_TIME_OUTSIDE_WINDOW");
});

test("cross-context, same-camera, plate mismatch, and ambiguity fail closed", () => {
  const anchor = observation();
  assert.equal(evaluateShadowPair(anchor, [observation({
    read_id: 2,
    overview_context: "entry",
    read_camera_name: "Entry LPR 1",
  })]).reason, "NO_CONFIDENT_COMPANION");
  assert.equal(evaluateShadowPair(anchor, [observation({ read_id: 2 })]).reason,
    "NO_CONFIDENT_COMPANION");
  assert.equal(evaluateShadowPair(anchor, [observation({
    read_id: 2,
    read_camera_name: "Street LPR 2",
    effective_plate: "XYZ999",
  })]).reason, "NO_CONFIDENT_COMPANION");

  const first = observation({ read_id: 2, read_camera_name: "Street LPR 2" });
  const second = observation({ read_id: 3, read_camera_name: "Street LPR 3" });
  const ambiguous = evaluateShadowPair(anchor, [first, second]);
  assert.equal(ambiguous.outcome, "rejected");
  assert.equal(ambiguous.reason, "AMBIGUOUS_COMPANIONS");
  assert.equal(ambiguous.candidateCount, 2);
});

test("display-only Entry-to-Street fallback can never become identity evidence", () => {
  const fallback = observation({
    overview_context: "entry",
    source_kind: "entry_overview_route_fallback",
    identity_eligible: false,
    read_camera_name: "Street LPR 1",
  });
  assert.equal(evaluateShadowPair(fallback, []).reason, "ANCHOR_NOT_ELIGIBLE");
  assert.equal(evaluateShadowPair({ ...fallback, identity_eligible: true }, []).reason,
    "ANCHOR_NOT_ELIGIBLE");
});

test("decision identity changes with a current-link revision", () => {
  const anchor = observation();
  const rejected = evaluateShadowPair(anchor, []);
  assert.notEqual(
    shadowDecisionIdentity(anchor, rejected),
    shadowDecisionIdentity({ ...anchor, source_updated_at: "2026-08-14 19:00:02.000000-06" }, rejected)
  );
});

test("disabled shadow service is inert and enabled service records proposals and rejections", async () => {
  let listed = 0;
  const disabled = new VehicleEventShadowService({
    repository: {
      async getControl() { return { enabled: false, batchSize: 25, settleSeconds: 20 }; },
      async listPendingCandidates() { listed += 1; return []; },
    },
  });
  assert.equal((await disabled.processBatch()).activation, "disabled");
  assert.equal(listed, 0);

  const anchor = observation();
  const companion = observation({ read_id: 102, read_camera_name: "Street LPR 2" });
  const calls = [];
  const service = new VehicleEventShadowService({
    repository: {
      async getControl() { return { enabled: true, batchSize: 25, settleSeconds: 20 }; },
      async retireStaleEvents() { calls.push("retire"); return 0; },
      async listPendingCandidates() { return [anchor, observation({ read_id: 103 })]; },
      async findCompanions(row) { return row.read_id === 101 ? [companion] : []; },
      async createProposedEvent() { calls.push("propose"); return { status: "proposed" }; },
      async recordRejectedDecision() { calls.push("reject"); return { status: "rejected", created: true }; },
    },
  });
  const result = await service.processBatch();
  assert.equal(result.processed, 2);
  assert.equal(result.proposed, 1);
  assert.equal(result.rejected, 1);
  assert.deepEqual(calls, ["retire", "propose", "reject"]);
});

test("worker remains low priority while idle and wakes quickly after work", async () => {
  let mode = "idle";
  const worker = new VehicleEventShadowWorker({
    service: {
      async processBatch() {
        return mode === "idle"
          ? { processed: 0, retired: 0, activation: "disabled" }
          : { processed: 1, proposed: 1, retired: 0, activation: "active" };
      },
    },
  });
  assert.equal((await worker.runOnce()).delayMs, 30_000);
  mode = "working";
  assert.equal((await worker.runOnce()).delayMs, 250);
  assert.equal(worker.snapshot().lastBatch.proposed, 1);
});

test("migration and repository keep the event slice additive, default-off, and provider-neutral", async () => {
  const [migration, repository, service, instrumentation] = await Promise.all([
    fs.readFile(path.join(ROOT, "migrations.sql"), "utf8"),
    fs.readFile(path.join(ROOT, "lib/vehicle-event-shadow-repository.mjs"), "utf8"),
    fs.readFile(path.join(ROOT, "lib/vehicle-event-shadow.mjs"), "utf8"),
    fs.readFile(path.join(ROOT, "instrumentation.node.js"), "utf8"),
  ]);
  const sliceStart = migration.indexOf("-- Provider-neutral shadow passage events");
  const sliceEnd = migration.indexOf("-- Asset-owned vehicle crops", sliceStart);
  const slice = migration.slice(sliceStart, sliceEnd);
  assert.match(slice, /2026081405_vehicle_event_shadow_correlation/);
  assert.match(slice, /vehicle_event_shadow_control/);
  assert.match(slice, /enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_events/);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_event_reads/);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_event_assets/);
  assert.match(slice, /CREATE TABLE IF NOT EXISTS public\.vehicle_event_shadow_decisions/);
  assert.doesNotMatch(slice, /UPDATE public\.plate_reads|ALTER TABLE public\.plate_reads/);
  assert.doesNotMatch(slice, /INSERT INTO public\.vehicle_events[\s\S]*SELECT/);
  assert.match(repository, /links\.identity_eligible = TRUE/);
  assert.match(repository, /reads\.vehicle_image_path = links\.source_path_snapshot/);
  assert.match(repository, /vehicle_image_source_read_id IS NOT DISTINCT FROM links\.source_read_id/);
  assert.match(repository, /vehicle_image_timestamp IS NOT DISTINCT FROM links\.captured_at/);
  assert.match(repository, /vehicle_image_updated_at IS NOT DISTINCT FROM links\.source_updated_at/);
  assert.match(repository, /FOR UPDATE OF reads, links/);
  assert.match(repository, /context === "entry" \? 5_000 : 12_000/);
  assert.match(instrumentation, /startVehicleEventShadowRuntimeWithRetry/);
  assert.doesNotMatch(`${slice}\n${repository}\n${service}`, /plate recognizer|platerecognizer/i);
  assert.doesNotMatch(`${repository}\n${service}`, /capture_assets|vehicle_attribute_observations|notification_/);
});

test("Processing UI exposes shadow-only controls and recent read evidence", async () => {
  const [panel, loader, settings, actions] = await Promise.all([
    fs.readFile(path.join(ROOT, "components/settings/VehicleEventShadowPanel.jsx"), "utf8"),
    fs.readFile(path.join(ROOT, "app/settings/vehicle-intelligence/VehicleIntelligenceSectionPage.jsx"), "utf8"),
    fs.readFile(path.join(ROOT, "components/settings/VehicleIntelligenceSettings.jsx"), "utf8"),
    fs.readFile(path.join(ROOT, "app/actions.js"), "utf8"),
  ]);
  assert.match(panel, /Shadow vehicle events/);
  assert.match(panel, /Enable shadow correlation/);
  assert.match(panel, /Run one shadow batch now/);
  assert.match(panel, /Ambiguous evidence fails closed/);
  assert.match(panel, /no Plate Recognizer or other external provider is contacted/);
  assert.match(panel, /live_feed\?readId=/);
  assert.match(loader, /getVehicleEventShadowOverview/);
  assert.match(settings, /<VehicleEventShadowPanel initialOverview=\{initialVehicleEventShadow\}/);
  for (const action of [
    "getVehicleEventShadowOverview",
    "setVehicleEventShadowEnabled",
    "runVehicleEventShadowBatch",
  ]) assert.match(actions, new RegExp(`export async function ${action}\\b`));
});

test("real PostgreSQL shadow gate is disposable-only and wired into CI", async () => {
  const [script, workflow] = await Promise.all([
    fs.readFile(path.join(ROOT, "scripts/test-vehicle-event-shadow-postgres.mjs"), "utf8"),
    fs.readFile(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"),
  ]);
  const guardEnd = script.indexOf("guardPassed = true");
  const firstFixtureMutation = script.indexOf("async function insertActorAndCompletedCatalog");
  assert.ok(guardEnd > 0 && guardEnd < firstFixtureMutation);
  assert.match(script, /VEHICLE_EVENT_SHADOW_POSTGRES_TEST_OPT_IN/);
  assert.match(script, /current_database\(\)/);
  assert.match(script, /codex_integration_test_guard/);
  assert.match(script, /host_maintenance_environment_identity/);
  assert.match(script, /vehicle_event_shadow_postgres_gate=passed/);
  assert.doesNotMatch(script, /process\.env\.(?:STORAGE_PATH|STORAGE_ROOT)|rm\s+-rf/i);
  assert.match(workflow, /'vehicle-event-shadow:v1', 'ci-disposable-pg17'/);
  assert.match(workflow, /yarn test:vehicle-event-shadow:postgres/);
});
