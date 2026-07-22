import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("live feed plate identities open exact matching read history", async () => {
  const plateTable = await source("components/PlateTable.jsx");

  assert.match(
    plateTable,
    /live_feed\?search=\$\{encodeURIComponent\(plate\.plate_number\)\}&matchMode=off/
  );
  assert.match(
    plateTable,
    /className="text-foreground underline-offset-4 hover:underline/
  );
  assert.doesNotMatch(
    plateTable,
    /className="text-blue-600 underline-offset-4 hover:underline/
  );
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

test("Watchlist explains unified-rule behavior and provides exact-read actions", async () => {
  const [page, table, database] = await Promise.all([
    source("app/flagged/page.jsx"),
    source("components/FlaggedPlatesTable.jsx"),
    source("lib/db.js"),
  ]);

  assert.match(page, /title="Watchlist"/);
  assert.match(table, /Watchlist is integrated with unified rules/);
  assert.match(table, /alterPlateFlag/);
  assert.match(table, /matchMode=off/);
  assert.match(database, /COUNT\(DISTINCT pr\.id\) as occurrence_count/);
});
