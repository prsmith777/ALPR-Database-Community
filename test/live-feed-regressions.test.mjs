import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = (path) => fs.readFile(path, "utf8");

test("Live Feed date ranges wait for a complete selection and keep timestamp predicates indexable", async () => {
  const [table, database] = await Promise.all([
    source("components/PlateTable.jsx"),
    source("lib/db.js"),
  ]);

  assert.match(table, /const \[dateRangeDraft, setDateRangeDraft\] = useState/);
  assert.match(table, /if \(!range\) \{[\s\S]*?dateFrom: null,[\s\S]*?dateTo: null/);
  assert.match(table, /if \(!nextRange\.from \|\| !nextRange\.to\) return/);
  assert.match(table, /selected=\{dateRangeDraft\}/);
  assert.match(table, /onSelect=\{handleDateRangeSelect\}/);
  assert.match(database, /pr\.timestamp >= \$\{dateFromParameter\}::date/);
  assert.match(database, /pr\.timestamp < \(\$\{dateToParameter\}::date \+ INTERVAL '1 day'\)/);
  assert.doesNotMatch(database, /pr\.timestamp::date BETWEEN/);
});

test("Live Feed plate links close the viewer without starting a competing refresh", async () => {
  const [table, wrapper] = await Promise.all([
    source("components/PlateTable.jsx"),
    source("components/PlateTableWrapper.jsx"),
  ]);

  assert.match(table, /const handlePlateFilterNavigation = useCallback/);
  assert.match(table, /onLiveChange\(false\);\s*closeImageViewer\(\)/);
  assert.equal((table.match(/onClick=\{handlePlateFilterNavigation\}/g) || []).length, 2);
  assert.match(table, /if \(!open\) closeImageViewer\(\)/);
  assert.match(wrapper, /wasOpen &&\s*!nextOpen &&\s*refreshAfterViewerCloseRef\.current/);
  assert.doesNotMatch(wrapper, /refreshAfterViewerCloseRef\.current \|\| isLiveModeActive/);
});

test("Live Feed count and page queries avoid optional joins and prefer Blue Iris short camera names", async () => {
  const [database, table, migrations] = await Promise.all([
    source("lib/db.js"),
    source("components/PlateTable.jsx"),
    source("migrations.sql"),
  ]);

  assert.match(database, /SELECT COUNT\(\*\)\s+FROM plate_reads pr/);
  assert.match(database, /const countDirectionJoin = requiresDirectionFilter/);
  assert.match(database, /const pagedDirectionJoin = requiresDirectionFilter \|\| sortsByDirection/);
  assert.match(database, /FROM public\.vehicle_overview_associations association/);
  assert.match(database, /profile\.source_camera_short_name/);
  assert.match(database, /overview_candidate_playback\.source_camera/);
  assert.match(database, /vehicle_image_selection_metadata->>'sourceCameraId'/);
  assert.match(database, /blue_iris_camera_inventory inventory/);
  assert.match(database, /plate_playback\.source_camera AS plate_bi_camera/);
  assert.match(table, /buildBlueIrisPlatePlaybackPath\(/);
  assert.match(table, /selectedImage\?\.plateBiCamera/);
  assert.match(migrations, /2026082202_blue_iris_camera_inventory/);
});

test("Blue Iris camera inventory refreshes at runtime startup without waiting for ingestion", async () => {
  const runtime = await source("lib/blue-iris-vehicle-frame-runtime.mjs");
  assert.match(runtime, /queue\.refreshCameraInventory\(\{ force: true \}\)/);
  assert.match(runtime, /blue_iris_camera_inventory_startup_refresh_failed/);
});
