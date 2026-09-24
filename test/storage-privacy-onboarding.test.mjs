import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Storage & Privacy presents a useful first-run surface without unavailable host features", async () => {
  const [shell, settings, health] = await Promise.all([
    source("components/settings/SettingsShell.jsx"),
    source("app/settings/SettingsForm.jsx"),
    source("app/settings/StorageHealthCard.jsx"),
  ]);

  assert.match(shell, /title: "Storage & Privacy"/);
  assert.match(settings, /Storage Overview/);
  assert.match(settings, /Monitoring &amp; Alerts/);
  assert.match(settings, /Advanced Maintenance/);
  assert.doesNotMatch(settings, /AI-agent/);
  assert.match(settings, /Pushover, MQTT, Email, signed webhooks, Blue Iris, and Home Assistant/);

  const storageTab = settings.slice(
    settings.indexOf('<TabsContent value="storage"'),
    settings.indexOf('<TabsContent value="monitoring"')
  );
  const monitoringTab = settings.slice(
    settings.indexOf('<TabsContent value="monitoring"'),
    settings.indexOf('<TabsContent value="cleanup"')
  );
  const advancedTab = settings.slice(
    settings.indexOf('<TabsContent value="cleanup"'),
    settings.indexOf('<TabsContent value="privacy"')
  );
  assert.match(storageTab, /StorageHealthCard/);
  assert.doesNotMatch(storageTab, /StorageMaintenancePanel/);
  assert.doesNotMatch(monitoringTab, /StorageHealthCard/);
  assert.match(monitoringTab, /StorageMaintenancePanel/);
  assert.match(advancedTab, /StorageHealthCard[\s\S]*StorageMaintenancePanel/);

  assert.match(health, /Host storage snapshot is not configured/);
  assert.match(health, /breakdown\?\.docker && <Metric/);
  assert.match(health, /breakdown\?\.backups && <Metric/);
  assert.doesNotMatch(health, /Host snapshot unavailable/);
  assert.match(health, /MAX_ACTIONABLE_PROJECTION_DAYS = 3650/);
  assert.match(health, /No capacity concern at the current observed rate/);
});

test("maintenance alerts disclose integration prerequisites and advanced controls stay advanced", async () => {
  const [panel, service] = await Promise.all([
    source("app/settings/StorageMaintenancePanel.jsx"),
    source("lib/storage-maintenance-service.mjs"),
  ]);

  assert.match(service, /emailConfigurationState/);
  assert.match(service, /webhookConfigurationState/);
  assert.match(service, /integrations:\s*\{/);
  assert.match(panel, /emailReady/);
  assert.match(panel, /webhookReady/);
  assert.match(panel, /href="\/settings\/integrations\/email"/);
  assert.match(panel, /href="\/settings\/integrations\/webhook"/);
  assert.match(panel, /Maintenance-specific destination URL/);
  assert.match(panel, /Advanced Maintenance tab/);
  assert.match(panel, /\{showCleanup && \([\s\S]*PostgreSQL maintenance observability/);
  assert.match(panel, /Tracked alert states/);
});

test("retention controls describe planning rather than enforcement", async () => {
  const [settings, health] = await Promise.all([
    source("app/settings/SettingsForm.jsx"),
    source("app/settings/StorageHealthCard.jsx"),
  ]);

  assert.match(settings, /Record-limit planning threshold/);
  assert.match(settings, /Image-retention planning period/);
  assert.match(settings, /does not automatically delete plate reads or source images/);
  assert.match(health, /never enforces the record limit or retention period/);
  assert.match(health, /never deletes plate reads or images/);
});
