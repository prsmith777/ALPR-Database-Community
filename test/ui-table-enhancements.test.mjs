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

  assert.match(plateTable, /const handleNextImage = \(\) =>/);
  assert.match(plateTable, /onClick=\{handleNextImage\}/);
  assert.match(plateTable, />Next read</);
  assert.match(plateTable, /className="flex shrink-0 gap-2"/);
  assert.match(plateTable, /Show next read \(Right Arrow\)/);
  assert.match(plateTable, /\[role="slider"\]/);
  assert.match(plateTable, /sm:grid-rows-\[auto_auto_minmax\(0,1fr\)_auto\].*sm:overflow-hidden/);
  assert.match(plateTable, /className="contents"/);
  assert.match(plateTable, /className="ml-auto flex gap-2"/);
  assert.match(imageViewer, /useState\(image\?\.crop_coordinates \? plateZoom : 1\)/);
  assert.match(imageViewer, /fitPlateOnOpen\s+\? getPlateFitZoom\(\)\s+: plateZoom/);
  assert.match(imageViewer, /new ResizeObserver\(updateContainerSize\)/);
  assert.match(imageViewer, /const fitScale = Math\.min\(/);
  assert.match(imageViewer, /const renderedPlateX = offsetX \+ centerX \* fitScale/);
  assert.match(imageViewer, /containerSize\.width \/ 2 - renderedPlateX \* zoom/);
  assert.match(imageViewer, /translate\(\$\{translateX\}px, \$\{translateY\}px\) scale\(\$\{zoom\}\)/);
  assert.match(imageViewer, /transformOrigin: "0 0"/);
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
  assert.match(imageViewer, /max=\{Math\.max\(5, getPlateFitZoom\(\)\)\}/);
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
  assert.match(redirectPage, /redirect\("\/known_plates\?view=monitored"\)/);
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
