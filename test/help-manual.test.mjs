import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HELP_ALL_ROLES,
  HELP_MANUAL,
  manualSearchText,
} from "../lib/help-manual.mjs";
import { generateHelpManualPdf } from "../lib/help-manual-pdf.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("the user guide is structured, searchable, and role-aware", () => {
  assert.equal(HELP_MANUAL.manualVersion, "1.8");
  assert.ok(HELP_MANUAL.sections.length >= 14);

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

test("the guide covers required workflows and clearly labels planned features", () => {
  const text = HELP_MANUAL.sections
    .map((section) => manualSearchText(section))
    .join("\n");

  for (const required of [
    "correct one read without losing evidence",
    "camera-scoped recurring alias",
    "strict",
    "balanced",
    "broad",
    "export the exact filtered investigation",
    "choose a role for a new user",
    "safely configure mqtt",
    "unified rules use guarded activation and cutover",
    "save disabled draft",
    "recent real reads",
    "matching real accepted read",
    "vehicle image similarity search",
    "configurable image overlays",
    "read storage health safely",
    "cannot delete or modify images",
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

test("production releases require help and roadmap updates", async () => {
  const [instructions, runbook, roadmap] = await Promise.all([
    source("AGENTS.md"),
    source("docs/personal-deployment.md"),
    source("docs/COMMUNITY_PRODUCT_ROADMAP.md"),
  ]);

  for (const text of [instructions, runbook]) {
    assert.match(text, /every production candidate/i);
    assert.match(text, /lib\/help-manual\.mjs/);
    assert.match(text, /docs\/COMMUNITY_PRODUCT_ROADMAP\.md/);
  }
  assert.match(roadmap, /Release baseline — July 24, 2026/);
  assert.doesNotMatch(roadmap, /current production release is `[0-9a-f]{7,40}`/i);
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

  assert.ok(pdf.length > 25_000, "the PDF should contain the detailed guide");
  assert.equal(sourceText.startsWith("%PDF-1.4\n"), true);
  assert.equal(sourceText.endsWith("%%EOF\n"), true);
  assert.match(sourceText, /\/Title \(ALPR Database Community User Guide\)/);
  assert.match(sourceText, /Getting started/);
  assert.match(sourceText, /Reviewing, correcting, and recurring aliases/);
  assert.match(sourceText, /Planned features that are not available yet/);

  const pageCount = Number(sourceText.match(/\/Type \/Pages \/Count (\d+)/)?.[1]);
  assert.ok(pageCount >= 10, `expected at least 10 PDF pages, received ${pageCount}`);
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
