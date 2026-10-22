import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("plate tables label icon-only row actions with accessible tooltips", async () => {
  const [liveFeed, plateDatabase, knownPlates, databaseFilters, rowActions] = await Promise.all([
    source("components/PlateTable.jsx"),
    source("components/plateDbTable.jsx"),
    source("components/KnownPlatesTable.jsx"),
    source("components/PlateDatabaseFilters.jsx"),
    source("components/TableRowActions.jsx"),
  ]);

  for (const component of [liveFeed, plateDatabase]) {
    assert.match(component, /TooltipProvider/);
    assert.match(component, /<TableRowActions/);
    assert.match(component, /label: "Add tag"/);
    assert.match(component, /<TooltipContent>Remove tag<\/TooltipContent>/);
    assert.match(component, /label: "Delete record"/);
    assert.match(component, /aria-label=\{`More actions for \$\{plate\.plate_number\}`\}/);
  }

  assert.match(rowActions, /<TooltipContent>\{action\.label\}<\/TooltipContent>/);
  assert.match(rowActions, /aria-label=\{action\.ariaLabel\}/);
  assert.match(rowActions, /aria-label=\{`Actions for \$\{plateNumber\}`\}/);
  assert.match(liveFeed, /aria-label="Open filters"/);
  assert.match(liveFeed, /<TooltipContent>Open filters<\/TooltipContent>/);
  assert.match(liveFeed, /label: "Correct plate"/);
  assert.match(liveFeed, /Confirm detected plate/);
  assert.match(liveFeed, /label: "View logs for this read"/);
  assert.match(liveFeed, /href: `\/logs\?readId=\$\{plate\.id\}&expand=first`/);
  assert.match(plateDatabase, /<TooltipContent>View insights<\/TooltipContent>/);
  assert.match(plateDatabase, /Monitor plate/);
  assert.match(knownPlates, /<TooltipProvider delayDuration=\{250\}>/);
  assert.match(knownPlates, /<IconTooltip label="Add tag">/);
  assert.match(knownPlates, /<IconTooltip label="Edit plate details">/);
  assert.match(knownPlates, /<IconTooltip label="More plate actions">/);
  assert.match(databaseFilters, /htmlFor="plate-database-search"/);
  assert.match(databaseFilters, /htmlFor="plate-database-match-mode"/);
  assert.match(databaseFilters, /htmlFor="plate-database-camera"/);
  assert.match(databaseFilters, /htmlFor="plate-database-page-size"/);
});

test("notification channel tests and MQTT broker action icons expose accessible labels", async () => {
  const [notifications, brokers] = await Promise.all([
    source("components/NotificationChannelTestPanel.jsx"),
    source("components/mqtt/MqttBrokers.jsx"),
  ]);

  assert.match(notifications, /aria-label="Pushover sample plate"/);
  assert.match(notifications, /Send test Pushover/);
  assert.match(notifications, /aria-label="Test email recipient"/);
  assert.match(notifications, /aria-label="Test webhook URL"/);
  assert.match(brokers, /<TooltipContent>Edit broker<\/TooltipContent>/);
  assert.match(brokers, /<TooltipContent>Delete broker<\/TooltipContent>/);

  assert.match(brokers, /TooltipTrigger asChild/);
  assert.match(brokers, /aria-label=/);
});

test("the desktop theme toggle uses the same accessible tooltip contract", async () => {
  const [sidebar, themeToggle] = await Promise.all([
    source("components/Sidebar.jsx"),
    source("components/ThemeToggle.jsx"),
  ]);

  assert.match(
    sidebar,
    /<TooltipTrigger asChild>\s*<ThemeToggle \/>\s*<\/TooltipTrigger>/
  );
  assert.match(sidebar, /<TooltipContent[^>]*>\s*Toggle theme\s*<\/TooltipContent>/);
  assert.match(themeToggle, /forwardRef\(function ThemeToggle/);
  assert.match(themeToggle, /\{ onClick, \.\.\.props \}/);
  assert.match(themeToggle, /ref=\{ref\}/);
  assert.match(themeToggle, /\{\.\.\.props\}/);
  assert.match(themeToggle, /<span className="sr-only">Toggle theme<\/span>/);
});
