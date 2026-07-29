import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createColorSignature } from "../lib/image-similarity.mjs";
import { CaptureAssetRepository } from "../lib/capture-asset-repository.mjs";
import { CaptureAssetService } from "../lib/capture-asset-service.mjs";
import {
  VEHICLE_COLOR_MODEL,
  VEHICLE_TYPE_MODEL,
  VEHICLE_TYPE_PROVIDER,
  assessVehicleColorPixels,
  inferVehicleColor,
  inferVehicleType,
} from "../lib/vehicle-attributes.mjs";
import { chooseShadowCluster } from "../lib/vehicle-clustering.mjs";
import { VEHICLE_INTELLIGENCE_NAVIGATION } from "../lib/vehicle-intelligence-navigation.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function pixels(red, green, blue) {
  const result = Buffer.alloc(16 * 16 * 3);
  for (let offset = 0; offset < result.length; offset += 3) {
    result[offset] = red;
    result[offset + 1] = green;
    result[offset + 2] = blue;
  }
  return result;
}

function vector(x, y) {
  const result = new Float32Array(512);
  result[0] = x;
  result[1] = y;
  return result;
}

test("vehicle color remains per-read evidence with confidence", () => {
  assert.deepEqual(
    { ...inferVehicleColor(createColorSignature(pixels(220, 20, 20))), signature: undefined },
    { status: "ready", value: "red", confidence: 0.99, reliability: 1, signature: undefined }
  );
  assert.equal(inferVehicleColor(createColorSignature(pixels(240, 240, 240))).value, "white");
  assert.equal(inferVehicleColor(createColorSignature(pixels(10, 10, 10))).value, "black");
});

test("monochrome night captures do not receive a guessed vehicle color", () => {
  const monochrome = Buffer.alloc(16 * 16 * 3);
  for (let offset = 0; offset < monochrome.length; offset += 3) {
    const value = (offset / 3 * 17) % 256;
    monochrome[offset] = value;
    monochrome[offset + 1] = Math.min(255, value + 2);
    monochrome[offset + 2] = Math.max(0, value - 2);
  }
  const observation = assessVehicleColorPixels(monochrome);
  assert.deepEqual(
    {
      status: observation.status,
      value: observation.value,
      confidence: observation.confidence,
      reason: observation.reason,
      monochromeRatio: observation.monochromeRatio,
    },
    {
      status: "unknown",
      value: null,
      confidence: null,
      reason: "monochrome_capture",
      monochromeRatio: 1,
    }
  );
  assert.match(VEHICLE_COLOR_MODEL, /v2$/);
});

test("color assessment remains enabled for genuinely chromatic captures", () => {
  const observation = assessVehicleColorPixels(pixels(220, 20, 20));
  assert.equal(observation.status, "ready");
  assert.equal(observation.value, "red");
  assert.equal(observation.reason, null);
  assert.equal(observation.monochromeRatio, 0);
});

test("live-feed vehicle descriptors use a side rail without reducing image height", async () => {
  const table = await source("components/PlateTable.jsx");
  assert.match(table, /w-\[calc\(100vw-2rem\)\][^\n]*max-w-7xl/);
  assert.match(table, /lg:grid-cols-\[minmax\(0,1fr\)_11rem\]/);
  assert.match(table, /<div className="contents">/);
  assert.match(table, /lg:col-start-2 lg:row-span-2 lg:row-start-1/);
  assert.match(table, /<ImageViewer[\s\S]*?<aside className="h-full rounded-lg border p-2\.5 text-sm [^"]*lg:min-h-0">/);
  assert.match(table, /<aside[\s\S]*?<div className="text-xs uppercase text-muted-foreground">Type<\/div>[\s\S]*?<div className="text-xs uppercase text-muted-foreground">Color<\/div>/);
  assert.match(table, /<aside[\s\S]*?<span>Direction<\/span>/);
  assert.match(table, /text-lg font-semibold leading-tight/);
  assert.match(table, /focus_coordinates: selectedImageView === "vehicle"/);
  assert.match(table, /zoomLabel=\{selectedImageView === "vehicle" \? "Zoom to Vehicle" : "Zoom to Plate"\}/);
  assert.match(table, /<DialogFooter className="self-end lg:col-start-1 lg:row-start-2">[\s\S]*?className="grid w-full gap-2"/);
  const directionSection = table.slice(table.indexOf("<span>Direction</span>"), table.indexOf("<aside"));
  assert.doesNotMatch(directionSection, /vehicleColor|vehicleBodyType/);
  const vehicleMetadata = table.slice(
    table.indexOf('<div className="text-xs uppercase text-muted-foreground">Vehicle</div>'),
    table.indexOf('<div className="relative h-[40vh]')
  );
  assert.match(vehicleMetadata, /Vehicle #\{selectedImage\.vehicleClusterId\}/);
  assert.doesNotMatch(vehicleMetadata, /vehicleClusterStatus|vehicleClusterSimilarity/);
});

test("vehicle images support centered zoom, drag panning, and full-screen inspection", async () => {
  const viewer = await source("components/ImageViewer.jsx");
  assert.match(viewer, /image\?\.focus_coordinates \|\| image\?\.crop_coordinates/);
  assert.match(viewer, /onPointerDown=\{handlePointerDown\}/);
  assert.match(viewer, /onPointerMove=\{handlePointerMove\}/);
  assert.match(viewer, /onPointerUp=\{handlePointerUp\}/);
  assert.match(viewer, /data-testid=\{fullscreen \? "image-viewer-fullscreen" : "image-viewer-popup"\}/);
  assert.match(viewer, /onClick=\{handleImageClick\}/);
  assert.doesNotMatch(viewer, /onDoubleClick=/);
  assert.match(viewer, /now - previous\.time <= 550[\s\S]*?setIsFullscreen\(\(current\) => !current\)/);
  assert.match(viewer, /const handleCloseFullscreen[\s\S]*?event\.stopPropagation\(\)[\s\S]*?setIsFullscreen\(false\)/);
  assert.match(viewer, /onClick=\{handleCloseFullscreen\}[\s\S]*?aria-label="Close full screen image"/);
  assert.match(viewer, /suppressImageClickRef\.current = !wasClick/);
  assert.match(viewer, /now - previous\.time <= 550/);
  assert.match(viewer, /onPointerCancel=\{handlePointerCancel\}/);
  assert.match(viewer, /suppressImageClickRef\.current = false;[\s\S]*?lastImageClickRef\.current = null;[\s\S]*?\}, \[isFullscreen\]\)/);
  assert.match(viewer, /createPortal\(viewer\(true\), document\.body\)/);
});

test("plate and vehicle image selectors stack without spanning the image", async () => {
  const table = await source("components/PlateTable.jsx");
  assert.match(table, /absolute left-2 top-2 z-20 flex flex-col rounded-md/);
  assert.match(table, /className="h-7 justify-start px-2 text-xs"/);
  assert.match(table, />Plate capture<\/Button>/);
  assert.match(table, />Vehicle view<\/Button>/);
});

test("live-feed refreshes do not reset a user's vehicle zoom", async () => {
  const viewer = await source("components/ImageViewer.jsx");
  assert.match(viewer, /const initializedViewRef = useRef\(null\)/);
  assert.match(viewer, /initializedViewRef\.current === viewResetKey/);
  assert.match(viewer, /initializedViewRef\.current = viewResetKey;[\s\S]*?setZoom\(clampZoom\(initialZoom\)\)/);
  assert.match(viewer, /setImageSize\(\{ url: image\.url, width: img\.width, height: img\.height \}\)/);
});

test("local vehicle type inference preserves confidence and model provenance", async () => {
  assert.deepEqual(inferVehicleType([0.8, 0.05, 0.1, 0.05]), {
    status: "ready",
    value: "car",
    confidence: 0.8,
    scores: { car: 0.8, bus: 0.05, truck: 0.1, van: 0.05 },
  });
  assert.deepEqual(inferVehicleType([0.4, 0.1, 0.3, 0.2]), {
    status: "unknown",
    value: null,
    confidence: 0.4,
    scores: { car: 0.4, bus: 0.1, truck: 0.3, van: 0.2 },
  });
  assert.equal(VEHICLE_TYPE_PROVIDER, "openvino-open-model-zoo");
  assert.match(VEHICLE_TYPE_MODEL, /vehicle-attributes-recognition-barrier-0039/);
  const [modelXml, modelBin, modelLicense] = await Promise.all([
    readFile(new URL("../models/visual-search/vehicle-attributes-recognition-barrier-0039.xml", import.meta.url)),
    readFile(new URL("../models/visual-search/vehicle-attributes-recognition-barrier-0039.bin", import.meta.url)),
    source("models/visual-search/LICENSE.open-model-zoo.txt"),
  ]);
  assert.ok(modelXml.length > 40_000);
  assert.ok(modelBin.length > 1_000_000);
  assert.match(modelLicense, /Apache License[\s\S]*Version 2\.0/);
});

test("automatic vehicle type analysis stores per-read evidence without manual labels", async () => {
  const saved = [];
  const service = new CaptureAssetService({
    repository: {
      async saveVehicleAttributeObservation(observation) { saved.push(observation); },
    },
    fileStorage: {
      async getImage(path) { return path === "derived/read-1.jpg" ? Buffer.from("image") : null; },
    },
    vehicleTypeAnalyzer: {
      async analyze() {
        return {
          status: "ready",
          value: "truck",
          confidence: 0.91,
          scores: { car: 0.04, bus: 0.02, truck: 0.91, van: 0.03 },
        };
      },
    },
    logger: {},
  });

  const result = await service.analyzeVehicleTypeAssets([
    { read_id: 1, derived_path: "derived/read-1.jpg" },
  ]);

  assert.deepEqual(result, {
    processed: 1,
    succeeded: 1,
    ready: 1,
    unknown: 0,
    failed: 0,
  });
  assert.deepEqual(saved[0], {
    readId: 1,
    attributeKey: "body_type",
    status: "ready",
    attributeValue: "truck",
    confidence: 0.91,
    provider: VEHICLE_TYPE_PROVIDER,
    modelVersion: VEHICLE_TYPE_MODEL,
    rawResult: {
      scores: { car: 0.04, bus: 0.02, truck: 0.91, van: 0.03 },
      input: "detected_vehicle_crop",
    },
  });
});

test("shadow clustering uses descriptor similarity and a continuous margin", () => {
  const suggested = chooseShadowCluster({
    embedding: vector(1, 0),
    candidates: [
      { clusterId: 12, embedding: vector(0.99, 0.02) },
      { clusterId: 14, embedding: vector(0.4, 0.9) },
    ],
  });
  assert.equal(suggested.decision, "suggest");
  assert.equal(suggested.clusterId, 12);
  assert.ok(suggested.similarity >= 0.9);
  assert.ok(suggested.margin >= 0.03);

  const ambiguous = chooseShadowCluster({
    embedding: vector(1, 0),
    candidates: [
      { clusterId: 12, embedding: vector(0.99, 0.02) },
      { clusterId: 14, embedding: vector(0.99, -0.02) },
    ],
  });
  assert.equal(ambiguous.decision, "seed");
  assert.equal(ambiguous.clusterId, null);
});

test("vehicle intelligence keeps ReID grouping separate from reviewed plate associations", async () => {
  const [migration, component, profileComponent, service, actions] = await Promise.all([
    readFile(new URL("../migrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../components/VehicleClusters.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/VehicleProfile.jsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/capture-asset-service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_attribute_observations/i);
  assert.match(migration, /2026072505_vehicle_attribute_observations/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_clusters/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_cluster_assignments/i);
  assert.match(migration, /representative_read_id[\s\S]*?REFERENCES public\.plate_reads\(id\) ON DELETE CASCADE/i);
  assert.match(migration, /2026072506_vehicle_shadow_clusters/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.vehicle_plate_associations/i);
  assert.match(migration, /2026072702_vehicle_plate_associations/i);
  assert.match(migration, /WHERE assignments\.assignment_status = 'confirmed'/i);
  assert.match(component, /Choose one queue/i);
  assert.match(component, /Plate associations/);
  assert.match(component, /Direction reviews/);
  assert.match(component, /Camera setup needs attention/);
  assert.match(component, /Showing \{first\.toLocaleString\(\)\}/);
  assert.match(component, /view === "review"/);
  assert.match(component, /queue=plates/);
  assert.match(component, /queue=direction/);
  assert.match(component, /queue=setup/);
  assert.match(await source("lib/vehicle-intelligence-navigation.mjs"), /title: "Needs Review"/);
  assert.match(component, /Open vehicle profile/i);
  assert.match(component, /Confirm vehicle/);
  assert.match(component, /Different vehicle/);
  assert.match(profileComponent, /Confirm association/);
  assert.match(profileComponent, /Reject association/);
  assert.match(profileComponent, /Plate text is shown as evidence and was not used/i);
  assert.match(service, /chooseShadowCluster\(\{ embedding: asset\.vehicle_embedding, candidates \}\)/);
  assert.doesNotMatch(service, /chooseShadowCluster\([\s\S]{0,300}plate_number/);
  assert.match(service, /clusterRecentUnassigned[\s\S]*?analyzeVehicleColorAssets\(assets\)/);
  assert.match(service, /analyzeRecentVehicleTypes/);
  assert.match(service, /attributeKey: "body_type"/);
  assert.doesNotMatch(service, /clusterRecentUnassigned[\s\S]{0,1800}?analyzeRecentVehicleColors\(bounded\)/);
  assert.match(actions, /reviewVehicleClusterSuggestion[\s\S]*?requirePermission\("plate\.review"\)/);
  assert.match(actions, /reviewVehiclePlateAssociation[\s\S]*?requirePermission\("plate\.review"\)/);
  assert.match(actions, /analyzeRecentVehicleClusters[\s\S]*?requirePermission\("maintenance\.manage"\)/);
});

test("plate association review is explicit, reversible, and audited", async () => {
  const calls = [];
  const repository = new CaptureAssetRepository({
    executor: {
      async query(sql, values = []) {
        calls.push({ sql, values });
        if (sql.includes("FROM public.vehicle_plate_associations") && sql.includes("FOR UPDATE")) {
          return { rows: [{ id: 8, cluster_id: 12, plate_number: "ABC123", status: "suggested", evidence_count: 3, confidence: 0.96, revision: 1 }] };
        }
        if (sql.includes("UPDATE public.vehicle_plate_associations SET")) {
          return { rows: [{ id: 8, cluster_id: 12, plate_number: "ABC123", status: "confirmed", evidence_count: 3, confidence: 0.96, revision: 2 }] };
        }
        return { rows: [] };
      },
    },
  });

  const result = await repository.reviewVehiclePlateAssociation({
    clusterId: 12,
    plateNumber: "abc123",
    decision: "confirm",
    actor: { id: 4, username: "operator", displayName: "Operator" },
  });

  assert.equal(result.status, "confirmed");
  const update = calls.find((call) => call.sql.includes("UPDATE public.vehicle_plate_associations SET"));
  assert.match(update.sql, /status = \$3::varchar/);
  assert.equal(update.values[1], "ABC123");
  const audit = calls.find((call) => call.sql.includes("vehicle.plate_association_review"));
  assert.ok(audit);
  assert.deepEqual(JSON.parse(audit.values[2]), {
    clusterId: 12,
    plateNumber: "ABC123",
    decision: "confirm",
    previousStatus: "suggested",
    status: "confirmed",
    evidenceCount: 3,
    revision: 2,
  });
});

test("vehicle intelligence settings always navigate to their dedicated route", async () => {
  const [shell, settingsForm, mainSidebar, vehicleSettings] = await Promise.all([
    source("components/settings/SettingsShell.jsx"),
    source("app/settings/SettingsForm.jsx"),
    source("components/Sidebar.jsx"),
    source("components/settings/VehicleIntelligenceSettings.jsx"),
  ]);
  assert.match(shell, /href: "\/settings\/vehicle-intelligence"/);
  assert.match(shell, /title: "Vehicle Setup"/);
  assert.match(mainSidebar, /label: "Vehicle Intelligence"/);
  assert.match(vehicleSettings, /vehicle-views/);
  assert.match(vehicleSettings, /vehicle-intelligence\/processing/);
  assert.match(vehicleSettings, /vehicle-intelligence\/calibration/);
  assert.match(vehicleSettings, /useRouteTab/);
  assert.match(shell, /<Link key=\{item\.id\} href=\{item\.href\}/);
  assert.match(shell, /settings-sidebar-collapsed/);
  assert.doesNotMatch(shell, /isLocalSection|onSelect &&/);
  assert.doesNotMatch(settingsForm, /onSelect=\{setActiveSection\}/);
});

test("every vehicle intelligence route shares the complete top navigation", async () => {
  assert.deepEqual(VEHICLE_INTELLIGENCE_NAVIGATION.map(({ title, href }) => ({ title, href })), [
    { title: "Visual Search", href: "/visual_search" },
    { title: "Vehicle Profiles", href: "/visual_search/vehicles" },
    { title: "Needs Review", href: "/visual_search/vehicles/review" },
  ]);

  const routes = [
    "app/visual_search/page.jsx",
    "app/visual_search/vehicles/page.jsx",
    "app/visual_search/vehicles/review/page.jsx",
    "app/visual_search/vehicles/[clusterId]/page.jsx",
  ];
  for (const route of routes) {
    const page = await source(route);
    assert.match(page, /navigation=\{VEHICLE_INTELLIGENCE_NAVIGATION\}/, route);
  }
});

test("vehicle cluster queries use one current vehicle asset per read", async () => {
  const calls = [];
  const repository = new CaptureAssetRepository({
    executor: {
      async query(text, values) {
        calls.push({ text, values });
        if (text.includes("total_clusters")) {
          return { rows: [{ total_clusters: 0, filtered_clusters: 0, shadow_clusters: 0, pending_reviews: 0, confirmed_assignments: 0, pending_plate_associations: 0, pending_direction_reviews: 0 }] };
        }
        return { rows: [] };
      },
    },
  });

  await repository.listVehicleClusterOverview();

  assert.equal(calls.length, 5);
  assert.equal(calls[0].values.length, 7);
  assert.match(calls[0].text, /JOIN LATERAL[\s\S]*?asset_type = \$1[\s\S]*?algorithm_version = \$2/i);
  assert.doesNotMatch(calls[0].text, /JOIN public\.capture_assets representative ON/i);
  assert.match(calls[0].text, /ORDER BY clusters\.updated_at DESC, clusters\.id DESC/i);
  assert.match(calls[0].text, /LIMIT \$6 OFFSET \$7/i);
  assert.equal(calls[0].values[5], 50);
  assert.equal(calls[0].values[6], 0);
  assert.equal(calls[1].values.length, 4);
  assert.match(calls[1].text, /JOIN LATERAL[\s\S]*?candidate[\s\S]*?JOIN LATERAL[\s\S]*?representative/i);
  assert.match(calls[2].text, /FROM public\.vehicle_plate_associations association[\s\S]*?WHERE association\.status = 'suggested'/i);
  assert.match(calls[2].text, /LIMIT \$3 OFFSET \$4/i);
  assert.match(calls[3].text, /labels\.id IS NULL[\s\S]*?observations\.status <> 'ready'/i);
  assert.match(calls[4].text, /pending_direction_reviews/i);
});

test("vehicle profile and review queues paginate independently", async () => {
  const calls = [];
  const repository = new CaptureAssetRepository({
    executor: {
      async query(text, values) {
        calls.push({ text, values });
        if (text.includes("total_clusters")) return { rows: [{}] };
        return { rows: [] };
      },
    },
  });

  const result = await repository.listVehicleClusterOverview({
    profilePage: 3,
    profilePageSize: 50,
    vehicleReviewPage: 2,
    plateReviewPage: 4,
    directionReviewPage: 5,
    reviewPageSize: 20,
    embeddingModel: "vehicle-model",
    directionClassifierVersion: "direction-model",
  });

  assert.equal(calls[0].values.at(-1), 100);
  assert.equal(calls[1].values.at(-1), 20);
  assert.equal(calls[2].values.at(-1), 60);
  assert.equal(calls[3].values.at(-1), 80);
  assert.equal(result.pagination.profiles.page, 3);
  assert.equal(result.pagination.plateReviews.page, 4);
});

test("vehicle cluster review explicitly types the shared status parameter", async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes("FOR UPDATE")) {
        return { rows: [{ read_id: 10, cluster_id: 20, assignment_status: "suggested", similarity: 0.97, revision: 1 }] };
      }
      if (text.includes("UPDATE public.vehicle_cluster_assignments")) {
        return { rows: [{ read_id: 10, cluster_id: 20, assignment_status: "confirmed", similarity: 0.97, similarity_margin: 0.08, revision: 2 }] };
      }
      return { rows: [] };
    },
  };
  const repository = new CaptureAssetRepository({ executor: client });

  await repository.reviewVehicleClusterAssignment({
    readId: 10,
    decision: "confirm",
    embeddingModel: "test-model",
    algorithmVersion: "test-cluster",
    actor: { id: 1, username: "tester", displayName: "Tester" },
  });

  const update = calls.find((call) => call.text.includes("UPDATE public.vehicle_cluster_assignments"));
  assert.match(update.text, /assignment_status = \$3::varchar/i);
  assert.match(update.text, /CASE WHEN \$3::varchar = 'seed'/i);
});
