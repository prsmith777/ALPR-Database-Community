import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("settings navigation uses dedicated paths without legacy section queries", async () => {
  const [rootPage, dedicatedPage, shell] = await Promise.all([
    source("app/settings/page.jsx"),
    source("app/settings/[section]/page.jsx"),
    source("components/settings/SettingsShell.jsx"),
  ]);

  assert.match(rootPage, /redirect\("\/settings\/general"\)/);
  for (const path of [
    "/settings/general",
    "/settings/database",
    "/settings/plate-matching",
    "/settings/review-corrections",
    "/settings/vehicle-intelligence",
    "/settings/data-privacy",
    "/settings/release",
    "/settings/security",
    "/settings/blue-iris",
    "/settings/home-assistant",
  ]) {
    assert.match(shell, new RegExp(path.replaceAll("/", "\\/")));
  }
  assert.doesNotMatch(shell, /\?section=/);
  assert.match(dedicatedPage, /"plate-matching": "plateMatching"/);
  assert.match(dedicatedPage, /"home-assistant": "homeassistant"/);
});

test("page-level tabs use clean route segments site-wide", async () => {
  const [hook, known, notifications, mqtt, channels] = await Promise.all([
    source("components/useRouteTab.js"),
    source("components/KnownPlatesWorkspace.jsx"),
    source("components/NotificationRulesWorkspace.jsx"),
    source("components/mqtt/MqttAdmin.jsx"),
    source("components/settings/IntegrationChannelSettings.jsx"),
  ]);

  assert.match(hook, /router\.push\(href, \{ scroll: false \}\)/);
  assert.match(known, /monitored: "\/known_plates\/monitored"/);
  assert.doesNotMatch(known, /\?view=/);
  assert.match(notifications, /activity: "\/notifications\/activity"/);
  assert.match(mqtt, /cameras: "\/settings\/integrations\/mqtt\/cameras"/);
  assert.match(mqtt, /activity: "\/settings\/integrations\/mqtt\/activity"/);
  assert.match(channels, /defaults: "\/settings\/integrations\/pushover\/defaults"/);
  assert.match(channels, /sender: "\/settings\/integrations\/email\/sender"/);
  assert.match(channels, /safety: "\/settings\/integrations\/webhook\/safety"/);
});

test("every clean page-level tab path has an application route", async () => {
  const routeFiles = [
    "app/known_plates/monitored/page.jsx",
    "app/notifications/activity/page.jsx",
    "app/settings/integrations/mqtt/cameras/page.jsx",
    "app/settings/integrations/mqtt/activity/page.jsx",
    "app/settings/integrations/pushover/defaults/page.jsx",
    "app/settings/integrations/pushover/usage/page.jsx",
    "app/settings/integrations/pushover/test/page.jsx",
    "app/settings/integrations/email/sender/page.jsx",
    "app/settings/integrations/email/test/page.jsx",
    "app/settings/integrations/webhook/safety/page.jsx",
    "app/settings/integrations/webhook/test/page.jsx",
  ];
  await Promise.all(routeFiles.map((path) => access(new URL(`../${path}`, import.meta.url))));
});
