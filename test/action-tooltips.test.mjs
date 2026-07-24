import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("plate tables label icon-only row actions with accessible tooltips", async () => {
  const [liveFeed, plateDatabase, knownPlates, databaseFilters] = await Promise.all([
    source("components/PlateTable.jsx"),
    source("components/plateDbTable.jsx"),
    source("components/KnownPlatesTable.jsx"),
    source("components/PlateDatabaseFilters.jsx"),
  ]);

  for (const component of [liveFeed, plateDatabase]) {
    assert.match(component, /TooltipProvider/);
    assert.match(component, /<TooltipContent>Add tag<\/TooltipContent>/);
    assert.match(component, /<TooltipContent>Remove tag<\/TooltipContent>/);
    assert.match(component, /<TooltipContent>Delete record<\/TooltipContent>/);
    assert.match(component, /aria-label=\{`More actions for \$\{plate\.plate_number\}`\}/);
  }

  assert.match(liveFeed, /aria-label="Open filters"/);
  assert.match(liveFeed, /<TooltipContent>Open filters<\/TooltipContent>/);
  assert.match(liveFeed, /<TooltipContent>Correct plate<\/TooltipContent>/);
  assert.match(liveFeed, /Confirm detected plate/);
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

test("notification and MQTT action icons expose hover and focus labels", async () => {
  const [notifications, brokers, rules] = await Promise.all([
    source("components/NotificationsTable.jsx"),
    source("components/mqtt/MqttBrokers.jsx"),
    source("components/mqtt/MqttRules.jsx"),
  ]);

  assert.match(notifications, /Send test notification/);
  assert.match(notifications, /Remove from notifications/);
  assert.match(brokers, /<TooltipContent>Edit broker<\/TooltipContent>/);
  assert.match(brokers, /<TooltipContent>Delete broker<\/TooltipContent>/);
  assert.match(rules, /<TooltipContent>Edit rule<\/TooltipContent>/);
  assert.match(rules, /<TooltipContent>Delete rule<\/TooltipContent>/);

  for (const component of [notifications, brokers, rules]) {
    assert.match(component, /TooltipTrigger asChild/);
    assert.match(component, /aria-label=/);
  }
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
