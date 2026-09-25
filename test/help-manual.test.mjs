import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HELP_ALL_ROLES,
  HELP_MANUAL,
  manualSearchText,
} from "../lib/help-manual.mjs";
import { generateHelpManualPdf } from "../lib/help-manual-pdf.mjs";
import {
  SETTINGS_HELP_COVERAGE,
  SETTINGS_HELP_ROUTES,
} from "../lib/settings-help-coverage.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("the user guide is structured, searchable, and role-aware", () => {
  assert.equal(HELP_MANUAL.manualVersion, "3.0");
  assert.ok(HELP_MANUAL.sections.length >= 24);

  const ids = HELP_MANUAL.sections.map((section) => section.id);
  assert.equal(new Set(ids).size, ids.length, "help anchors must be unique");

  for (const section of HELP_MANUAL.sections) {
    assert.match(section.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(section.title);
    assert.ok(section.summary);
    assert.ok(section.blocks.length > 0);
    assert.ok(section.roles.length > 0);
    assert.equal(
      section.roles.every((role) => HELP_ALL_ROLES.includes(role)),
      true,
      `${section.id} includes an unknown role`
    );
    assert.ok(manualSearchText(section).includes(section.title.toLowerCase()));
  }
});

test("every visible Settings route has specific manual coverage", async () => {
  const sectionById = new Map(HELP_MANUAL.sections.map((section) => [section.id, section]));
  assert.equal(new Set(SETTINGS_HELP_ROUTES).size, SETTINGS_HELP_ROUTES.length, "Settings routes must be unique");

  for (const entry of SETTINGS_HELP_COVERAGE) {
    const section = sectionById.get(entry.sectionId);
    assert.ok(section, `missing manual section ${entry.sectionId}`);
    assert.deepEqual(
      [...(section.settingsViews || [])].sort(),
      [...entry.routes].sort(),
      `${entry.sectionId} route metadata drifted from the coverage contract`
    );
    const text = manualSearchText(section);
    for (const term of entry.requiredTerms) {
      assert.ok(text.includes(term.toLowerCase()), `${entry.sectionId} must explain ${term}`);
    }
  }

  const shell = await source("components/settings/SettingsShell.jsx");
  const navigationRoutes = [...shell.matchAll(/href:\s*"(\/settings\/[^"]+)"/g)].map((match) => match[1]);
  for (const route of navigationRoutes) {
    assert.ok(SETTINGS_HELP_ROUTES.includes(route), `visible Settings navigation route ${route} is undocumented`);
  }
});

test("every concrete nested Settings page has a coverage entry", async () => {
  const { readdir } = await import("node:fs/promises");
  const settingsRoot = new URL("../app/settings/", import.meta.url);
  const discovered = [];

  async function walk(directory, parts = []) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith("[")) await walk(new URL(`${entry.name}/`, directory), [...parts, entry.name]);
      } else if (entry.name === "page.jsx" && parts.length > 0) {
        discovered.push(`/settings/${parts.join("/")}`);
      }
    }
  }

  await walk(settingsRoot);
  for (const route of discovered.filter((route) => route !== "/settings/integrations")) {
    assert.ok(SETTINGS_HELP_ROUTES.includes(route), `concrete Settings page ${route} is undocumented`);
  }
});

test("the guide covers required workflows and clearly labels planned features", () => {
  const text = HELP_MANUAL.sections
    .map((section) => manualSearchText(section))
    .join("\n");

  for (const required of [
    "correct one read without losing evidence",
    "export the exact filtered investigation",
    "safely configure mqtt",
    "save a disabled draft",
    "recent real reads",
    "test & activity",
    "vehicle image similarity search",
    "storage overview",
    "cannot delete original plate images",
    "monitoring & alerts",
    "advanced maintenance",
    "planning thresholds never delete plate reads",
    "create the blue iris plate-read action",
    "two credential directions",
    "home assistant integration",
    "rollback discards newer records",
    "guarded logical database migration",
    "run ./alpr-community",
    "guided fresh install",
    "verified release bootstrap on ubuntu server 24.04",
    "openvino, reid",
    "migration-preparation mode",
    "migrate wizard",
    "outbound-isolated target",
    "generated database password is not a login password",
    "empty-database proof",
    "linux guest and docker compose",
    "fetches canonical main explicitly",
    "tag-only git refspec",
    "one compressed database/configuration rollback generation",
    "recreates the public schema",
    "partitioned tables",
    "does not re-run migrations",
    "restricted host update service",
    "radar traffic correlation",
    "advanced visual-identity conversion",
    "use github discussions for setup questions",
    "public reports must be sanitized",
  ]) {
    assert.match(text, new RegExp(required, "i"));
  }
});

test("the Help page and PDF download allow every signed-in system role", async () => {
  const [page, route] = await Promise.all([
    source("app/help/page.jsx"),
    source("app/api/help/manual/route.js"),
  ]);

  assert.match(page, /requirePagePermission\("plate\.read"\)/);
  assert.doesNotMatch(page, /maintenance\.manage/);
  assert.match(page, /<HelpManual manual=\{HELP_MANUAL\} \/>/);

  assert.match(route, /denyUnlessRoutePermission\("plate\.read"\)/);
  assert.match(route, /Content-Type": "application\/pdf"/);
  assert.match(route, /Content-Disposition/);
  assert.match(route, /Cache-Control": "private, no-store"/);
});

test("the desktop guide index scrolls independently", async () => {
  const help = await source("components/help/HelpManual.jsx");

  assert.match(help, /lg:max-h-\[calc\(100vh-2rem\)\]/);
  assert.match(help, /lg:overflow-y-auto/);
  assert.match(help, /lg:overscroll-contain/);
});

test("the Help Center links users to safe public and private feedback channels", async () => {
  const help = await source("components/help/HelpManual.jsx");

  assert.match(help, /ALPR-Database-Community\/discussions/);
  assert.match(help, /issues\/new\?template=bug_report\.yml/);
  assert.match(help, /issues\/new\?template=feature_request\.yml/);
  assert.match(help, /security\/advisories\/new/);
  assert.match(help, /Issues and discussions are public/);
  assert.match(help, /target="_blank"/);
  assert.match(help, /rel="noreferrer"/);
});

test("Community releases include public deployment and roadmap guidance", async () => {
  const [readme, runbook, roadmap] = await Promise.all([
    source("README.md"),
    source("docs/DEPLOYMENT.md"),
    source("docs/COMMUNITY_PRODUCT_ROADMAP.md"),
  ]);

  assert.match(readme, /docs\/DEPLOYMENT\.md/);
  assert.match(readme, /docs\/COMMUNITY_PRODUCT_ROADMAP\.md/);
  assert.match(runbook, /empty PostgreSQL 17 database on a fresh volume/);
  for (const required of [
    "Available now",
    "Vehicle images and direction",
    "Notifications and integrations",
    "Installation, migration, and updates",
    "Intentionally not shipped",
    "Prioritized later work",
    "sample plate reads",
    "restricted browser-to-host service",
    "ARM support is deferred",
  ]) {
    assert.match(roadmap, new RegExp(required, "i"));
  }
  assert.doesNotMatch(roadmap, /Publish generic sample data/i);
  assert.doesNotMatch(`${readme}\n${runbook}\n${roadmap}`, /personal-deployment\.md/);
});

test("dashboard places Help immediately after Roadmap", async () => {
  const dashboard = await source("app/dashboard/DashboardMetrics.jsx");
  const roadmap = dashboard.indexOf('label="Community product roadmap"');
  const help = dashboard.indexOf('label="Help and user guide"');

  assert.ok(roadmap >= 0, "roadmap button is missing");
  assert.ok(help > roadmap, "Help must follow Roadmap");
  assert.ok(help - roadmap < 900, "Help must remain adjacent to Roadmap");
  assert.match(dashboard.slice(roadmap, help + 350), /href="\/help"/);
  assert.match(dashboard.slice(roadmap, help + 350), /aria-label="Help and user guide"/);
});

test("the generated download is a multi-page PDF containing the manual", () => {
  const pdf = generateHelpManualPdf(HELP_MANUAL);
  const sourceText = pdf.toString("ascii");

  assert.ok(pdf.length > 15_000, "the PDF should contain the Community guide");
  assert.equal(sourceText.startsWith("%PDF-1.4\n"), true);
  assert.equal(sourceText.endsWith("%%EOF\n"), true);
  assert.match(sourceText, /\/Title \(ALPR Database Community User Guide\)/);
  assert.match(sourceText, /Getting started/);
  assert.match(sourceText, /Known plates, monitored plates, and tags/);
  assert.match(sourceText, /Blue Iris integration/);
  assert.match(sourceText, /Home Assistant integration/);
  assert.match(sourceText, /Planned features that are not available yet/);

  const pageCount = Number(sourceText.match(/\/Type \/Pages \/Count (\d+)/)?.[1]);
  assert.ok(pageCount >= 12, `expected at least 12 PDF pages, received ${pageCount}`);
  assert.equal(
    (sourceText.match(/\/Type \/Page \/Parent/g) || []).length,
    pageCount,
    "PDF page tree count must match page objects"
  );
});

test("PDF generation rejects an empty content model", () => {
  assert.throws(
    () => generateHelpManualPdf({ title: "Empty", sections: [] }),
    /populated help manual/
  );
});

test("PDF block headings reserve room for following content", async () => {
  const pdfSource = await source("lib/help-manual-pdf.mjs");
  const blockStart = pdfSource.indexOf("renderBlock(block)");
  const noteStart = pdfSource.indexOf('if (block.type === "note")', blockStart);
  assert.ok(blockStart >= 0 && noteStart > blockStart);
  assert.match(pdfSource.slice(blockStart, noteStart), /ensureSpace\(54\)/);
  assert.match(pdfSource, /section heading, summary, role line, and first block together[\s\S]*ensureSpace\(130\)/);
});
