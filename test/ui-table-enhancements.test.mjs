import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("live feed plate identities open exact matching read history", async () => {
  const [plateTable, knownPlatesTable] = await Promise.all([
    source("components/PlateTable.jsx"),
    source("components/KnownPlatesTable.jsx"),
  ]);

  for (const component of [plateTable, knownPlatesTable]) {
    assert.match(
      component,
      /live_feed\?search=\$\{encodeURIComponent\(plate\.plate_number\)\}&matchMode=off/
    );
    assert.match(component, /View exact reads for \$\{plate\.plate_number\}/);
  }
  assert.match(
    plateTable,
    /className="text-foreground underline-offset-4 hover:underline/
  );
  assert.doesNotMatch(
    plateTable,
    /className="text-blue-600 underline-offset-4 hover:underline/
  );
});

test("live feed image review advances visibly and starts focused on the plate", async () => {
  const [plateTable, imageViewer] = await Promise.all([
    source("components/PlateTable.jsx"),
    source("components/ImageViewer.jsx"),
  ]);

  assert.match(plateTable, /const handleNextImage = useCallback\(\(\) =>/);
  assert.match(plateTable, /onClick=\{handleNextImage\}/);
  assert.match(plateTable, /onViewerPageChange/);
  assert.doesNotMatch(plateTable, /\(selectedIndex \+ 1\) % data\.length/);
  assert.match(plateTable, />Next read</);
  assert.match(plateTable, /Retry vehicle view/);
  assert.match(plateTable, /retryBlueIrisVehicleFrameForRead/);
  assert.match(plateTable, /Failed after \$\{selectedImage\.vehicleImageAttemptCount \|\| 3\} attempts/);
  assert.match(plateTable, /Delete this read/);
  assert.match(plateTable, /setIsDeleteConfirmOpen\(true\)/);
  assert.match(plateTable, /<DialogTitle>Confirm Deletion<\/DialogTitle>/);
  assert.match(plateTable, /selectedImage\?\.id === activePlate\.id/);
  assert.match(plateTable, /className="grid w-full gap-2"/);
  assert.match(plateTable, /Show next read \(Right Arrow\)/);
  assert.match(plateTable, /\[role="slider"\]/);
  assert.match(plateTable, /sm:grid-rows-\[minmax\(0,1fr\)_auto\].*sm:overflow-hidden/);
  assert.match(plateTable, /<DialogTitle className="sr-only">[\s\S]*?License Plate Image/);
  assert.match(plateTable, /className="flex flex-wrap items-center gap-2"/);
  assert.match(plateTable, /className="ml-auto flex gap-2"/);
  assert.match(imageViewer, /useState\(image\?\.crop_coordinates \? plateZoom : 1\)/);
  assert.match(imageViewer, /const midpoint = \(1 \+ getSliderMax\(\)\) \/ 2/);
  assert.match(imageViewer, /Math\.round\(midpoint \* 10\) \/ 10/);
  assert.match(imageViewer, /new ResizeObserver\(updateContainerSize\)/);
  assert.match(imageViewer, /const fitScale = Math\.min\(/);
  assert.match(imageViewer, /const renderedPlateX = offsetX \+ centerX \* fitScale/);
  assert.match(imageViewer, /containerSize\.width \/ 2 - renderedPlateX \* zoom/);
  assert.match(imageViewer, /translate\(\$\{translateX\}px, \$\{translateY\}px\) scale\(\$\{zoom\}\)/);
  assert.match(imageViewer, /transformOrigin: "0 0"/);
  assert.match(imageViewer, /const handleWheel = useCallback/);
  assert.match(imageViewer, /event\.preventDefault\(\)/);
  assert.match(imageViewer, /const wheelStep = \(getSliderMax\(\) - 1\) \/ 6/);
  assert.match(imageViewer, /setZoom\(\(currentZoom\) => clampZoom\(currentZoom \+ direction \* wheelStep\)\)/);
  assert.match(imageViewer, /addEventListener\("wheel", handleWheel, \{ passive: false \}\)/);
  assert.match(imageViewer, /removeEventListener\("wheel", handleWheel\)/);
  assert.match(imageViewer, /Scroll to zoom/);
  assert.match(imageViewer, />\s*Reset/);
});

test("plate correction opens with an editable caret instead of selected text", async () => {
  const [plateTable, imageViewer] = await Promise.all([
    source("components/PlateTable.jsx"),
    source("components/ImageViewer.jsx"),
  ]);

  assert.match(plateTable, /const correctionInputRef = useRef\(null\)/);
  assert.match(plateTable, /onOpenAutoFocus=\{\(event\) => \{/);
  assert.match(plateTable, /input\.setSelectionRange\(cursorPosition, cursorPosition\)/);
  assert.match(plateTable, /ref=\{correctionInputRef\}/);
  assert.match(plateTable, /Plate image/);
  assert.match(plateTable, /compactControls\s+fitPlateOnOpen/);
  assert.match(imageViewer, /fitPlateOnOpen = false/);
  assert.match(imageViewer, /const margin = 0\.85/);
  assert.match(imageViewer, /const MAX_PLATE_ZOOM = 12/);
  assert.match(imageViewer, /Math\.floor\(fittedZoom \* 10\) \/ 10/);
  assert.match(imageViewer, /max=\{getSliderMax\(\)\}/);
  assert.match(imageViewer, /"grid grid-cols-2 gap-2 py-2"/);
  assert.match(imageViewer, /"col-span-2 px-1"/);
  assert.match(imageViewer, /<Slider/);
  assert.match(imageViewer, />\s*Reset/);
  assert.match(imageViewer, />\s*Zoom to Plate/);
});

test("plate identifiers request a slashed-zero glyph throughout the interface", async () => {
  const [styles, plateTable] = await Promise.all([
    source("app/globals.css"),
    source("components/PlateTable.jsx"),
  ]);

  assert.match(styles, /font-variant-numeric: slashed-zero/);
  assert.match(styles, /font-feature-settings: "zero" 1/);
  assert.match(styles, /var\(--font-geist-mono\)/);
  assert.match(plateTable, /Camera read \{observed\}/);
  assert.doesNotMatch(plateTable, /text-\[11px\] font-sans text-muted-foreground/);
});

test("table pagination scrolls the application content to the top", async () => {
  const [scrollHelper, liveFeed, database] = await Promise.all([
    source("lib/page-scroll.mjs"),
    source("components/PlateTableWrapper.jsx"),
    source("components/plateDbTable.jsx"),
  ]);

  assert.match(scrollHelper, /document\.querySelector\("main"\)/);
  assert.match(scrollHelper, /scrollTo\(\{ top: 0, left: 0, behavior: "auto" \}\)/);
  assert.match(liveFeed, /scrollMainToTop\(\)/);
  assert.match(database, /scrollMainToTop\(\)/);
});

test("live feed and plate database expose large and multi-select filters", async () => {
  const [liveFeed, databaseFilters, exportRoute] = await Promise.all([
    source("components/PlateTable.jsx"),
    source("components/PlateDatabaseFilters.jsx"),
    source("app/api/exports/plates/route.js"),
  ]);

  for (const component of [liveFeed, databaseFilters]) {
    assert.match(component, /MultiSelectFilter/);
    assert.match(component, /250, 500/);
  }
  assert.match(exportRoute, /getAll\("tag"\)/);
  assert.match(exportRoute, /getAll\("camera"\)/);
});

test("live feed date picker remains within the visible viewport", async () => {
  const plateTable = await source("components/PlateTable.jsx");

  assert.match(plateTable, /--radix-popover-content-available-height/);
  assert.match(plateTable, /overflow-y-auto overscroll-contain/);
  assert.match(plateTable, /collisionPadding=\{16\}/);
  assert.match(plateTable, /sticky="always"/);
  assert.match(plateTable, /w-\[520px\]/);
  assert.match(plateTable, /numberOfMonths=\{2\}[\s\S]*?fixedWeeks/);
});

test("live feed review status filtering is multi-select, URL-backed, and server-side", async () => {
  const [table, wrapper, page, actions, database] = await Promise.all([
    source("components/PlateTable.jsx"),
    source("components/PlateTableWrapper.jsx"),
    source("app/live_feed/page.jsx"),
    source("app/actions.js"),
    source("lib/db.js"),
  ]);

  assert.match(table, /ariaLabel="Filter by review status"/);
  assert.match(table, /allLabel="All review statuses"/);
  for (const status of ["unreviewed", "confirmed", "corrected", "alias_resolved"]) {
    assert.match(table, new RegExp(`value: "${status}"`));
  }
  assert.match(wrapper, /params\.getAll\("reviewStatus"\)/);
  assert.match(page, /searchParamList\(searchParams\?\.reviewStatus\)/);
  assert.match(actions, /reviewStatuses: Array\.isArray\(reviewStatuses\)/);
  assert.match(database, /FILTERABLE_REVIEW_STATUSES/);
  assert.match(database, /"alias_resolved"/);
  assert.match(database, /pr\.review_status = ANY\(\$\{reviewStatusParameter\}::text\[\]\)/);
  assert.match(table, /reviewStatus: null/);
});

test("live feed direction is visible, correctable, and filterable by semantic camera label", async () => {
  const [table, wrapper, page, actions, database] = await Promise.all([
    source("components/PlateTable.jsx"),
    source("components/PlateTableWrapper.jsx"),
    source("app/live_feed/page.jsx"),
    source("app/actions.js"),
    source("lib/db.js"),
  ]);
  assert.match(table, /ariaLabel="Filter by direction"/);
  assert.match(table, /<DirectionBadge plate=\{plate\}/);
  assert.match(table, /direction_profile_configured[\s\S]*?"Pending"/);
  assert.match(wrapper, /setInterval\(\(\) => router\.refresh\(\), 10_000\)/);
  assert.match(table, /label="Direction"[\s\S]*?field="direction"/);
  assert.match(table, /aria-label="Review vehicle direction"/);
  assert.match(table, /className="h-4 w-4 shrink-0 p-0 text-muted-foreground hover:text-foreground"/);
  assert.match(table, /<Pencil className="h-2\.5 w-2\.5"/);
  assert.match(table, /<PopoverContent align="start" className="w-64 p-3">/);
  assert.match(table, /Front view/);
  assert.match(table, /Rear view/);
  assert.match(wrapper, /params\.getAll\("direction"\)/);
  assert.match(wrapper, /setDirectionOverrides/);
  assert.match(wrapper, /direction_label: observation\.directionLabel/);
  assert.match(wrapper, /directionOverrides\[plate\.id\]/);
  assert.match(page, /searchParamList\(searchParams\?\.direction\)/);
  assert.match(actions, /reviewVehicleDirection[\s\S]*?requirePermission\("plate\.review"\)/);
  assert.match(database, /LOWER\(direction\.direction_label\) = ANY/);
  assert.match(database, /UNKNOWN_DIRECTION_FILTER/);
});

test("the image viewer applies review results even when filtering removes the read", async () => {
  const table = await source("components/PlateTable.jsx");

  const optimisticUpdate = table.indexOf("setPendingReviewTargetValidated(nextValidated)");
  const serverUpdate = table.indexOf("await onValidate(readId, nextValidated)");
  assert.ok(optimisticUpdate >= 0 && optimisticUpdate < serverUpdate);
  assert.match(table, /reviewStatus: nextValidated \? "confirmed" : "unreviewed"/);
  assert.match(table, /pendingReviewTargetValidated\s*\? "Confirming\.\.\."/);
  assert.match(table, /if \(pendingReviewReadId === selectedImage\.id\) return/);
  assert.match(table, /currentReviewRevision >= selectedReviewRevision/);
  assert.match(table, /const result = await onValidate\(readId, nextValidated\)/);
  assert.match(table, /reviewStatus:\s*result\.data\?\.reviewStatus/);
  assert.match(table, /pendingReviewReadId === selectedImage\?\.id/);
  assert.match(table, /border-green-500\/60 bg-green-500\/10 text-green-500/);
});

test("the closed image viewer does not dereference a missing selected read", async () => {
  const plateTableSource = await source("components/PlateTable.jsx");

  assert.match(
    plateTableSource,
    /disabled=\{pendingReviewReadId === selectedImage\?\.id\}/
  );
  assert.match(
    plateTableSource,
    /\{pendingReviewReadId === selectedImage\?\.id/
  );
});

test("the image viewer summarizes known-plate and tag associations", async () => {
  const [table, wrapper] = await Promise.all([
    source("components/PlateTable.jsx"),
    source("components/PlateTableWrapper.jsx"),
  ]);

  assert.match(table, />Known plate</);
  assert.match(table, /selectedImage\.knownName \|\| "Not known"/);
  assert.match(table, />Tags</);
  assert.match(table, /selectedImage\.tags\.map\(\(tag\)/);
  assert.match(table, /handleSelectedImageAddTag\(tag\)/);
  assert.match(wrapper, /const handleAddTag[\s\S]*?return result;/);
  assert.match(wrapper, /const handleAddKnownPlate[\s\S]*?return result;/);
});

test("Monitored Plates is integrated with Known Plates and preserves exact-read actions", async () => {
  const [page, redirectPage, workspace, table, database, sidebar] = await Promise.all([
    source("app/known_plates/page.jsx"),
    source("app/flagged/page.jsx"),
    source("components/KnownPlatesWorkspace.jsx"),
    source("components/FlaggedPlatesTable.jsx"),
    source("lib/db.js"),
    source("components/Sidebar.jsx"),
  ]);

  assert.match(page, /KnownPlatesWorkspace/);
  assert.match(redirectPage, /redirect\("\/known_plates\/monitored"\)/);
  assert.match(workspace, /Monitored Plates/);
  assert.match(table, /Monitored Plates works with unified rules/);
  assert.match(table, /monitorReason/);
  assert.match(table, /monitorPriority/);
  assert.match(table, /alterPlateFlag/);
  assert.match(table, /matchMode=off/);
  assert.match(database, /COUNT\(DISTINCT pr\.id\) as occurrence_count/);
  assert.match(database, /monitor_reason/);
  assert.doesNotMatch(sidebar, /label: "Watchlist"/);
});
