import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PROJECT_DOCUMENTATION_URL,
  PROJECT_RELEASES_URL,
  PROJECT_REPOSITORY_URL,
  PROJECT_ROADMAP_URL,
} from "../lib/project-info.js";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("failed login clears and refocuses the controlled password input", async () => {
  const loginPage = await source("app/login/page.jsx");

  assert.match(loginPage, /const \[password, setPassword\] = useState\(""\)/);
  assert.match(loginPage, /const clearFailedPassword = \(\) =>/);
  assert.match(loginPage, /setPassword\(""\)/);
  assert.match(loginPage, /passwordInputRef\.current\?\.focus\(\)/);
  assert.match(loginPage, /new FormData\(event\.currentTarget\)/);
  assert.match(loginPage, /value=\{password\}/);
  assert.equal(
    [...loginPage.matchAll(/clearFailedPassword\(\)/g)].length,
    3,
    "each unsuccessful login path should clear the password"
  );
});

test("an empty Known Plates list still renders its management table", async () => {
  const knownPlatesPage = await source("app/known_plates/page.jsx");

  assert.match(knownPlatesPage, /<KnownPlatesTable initialData=\{knownPlates\} \/>/);
  assert.equal(knownPlatesPage.includes("knownPlates.length > 0"), false);
  assert.match(knownPlatesPage, /response\.error \|\| "Unable to load known plates\."/);
  assert.match(knownPlatesPage, /<Alert variant="destructive">/);
});

test("the mobile navigation sheet has an accessible dialog title", async () => {
  const sidebar = await source("components/Sidebar.jsx");

  assert.match(sidebar, /import \{ Sheet, SheetContent, SheetTitle \}/);
  assert.match(sidebar, /<SheetTitle className="text-lg font-semibold">Menu<\/SheetTitle>/);
  assert.equal(sidebar.includes('<h2 className="text-lg font-semibold">Menu</h2>'), false);
});

test("dashboard, manifests, README, and system logs identify the community fork", async () => {
  const [dashboard, logs, projectInfo, layout, manifest, publicManifest, readme] = await Promise.all([
    source("app/dashboard/DashboardMetrics.jsx"),
    source("app/logs/page.jsx"),
    source("lib/project-info.js"),
    source("app/layout.jsx"),
    source("app/manifest.js"),
    source("public/manifest.json"),
    source("README.md"),
  ]);

  assert.match(dashboard, /PROJECT_DOCUMENTATION_URL/);
  assert.match(dashboard, /PROJECT_REPOSITORY_URL/);
  assert.match(dashboard, /PROJECT_ROADMAP_URL/);
  assert.match(dashboard, /Fork source on GitHub/);
  assert.equal(dashboard.includes("algertc"), false);
  assert.match(logs, /getLocalVersionInfo/);
  assert.match(logs, /PROJECT_NAME/);
  assert.match(logs, /PROJECT_RELEASES_URL/);
  assert.match(projectInfo, /PROJECT_OWNER = "prsmith777"/);
  assert.match(projectInfo, /PROJECT_REPOSITORY_NAME = "ALPR-Database-Community"/);
  assert.match(projectInfo, /\/tree\/main\/docs/);
  assert.match(
    projectInfo,
    /\/blob\/main\/docs\/COMMUNITY_PRODUCT_ROADMAP\.md/
  );
  assert.match(projectInfo, /\/releases/);
  assert.match(layout, /PROJECT_DESCRIPTION/);
  assert.match(manifest, /PROJECT_NAME/);
  assert.match(publicManifest, /ALPR Database Community/);
  assert.match(readme, /ALPR Database Community/);
  for (const currentIdentity of [layout, manifest, publicManifest, readme]) {
    assert.equal(currentIdentity.includes("algertc"), false);
  }
  assert.equal(
    PROJECT_REPOSITORY_URL,
    "https://github.com/prsmith777/ALPR-Database-Community"
  );
  assert.equal(
    PROJECT_DOCUMENTATION_URL,
    "https://github.com/prsmith777/ALPR-Database-Community/tree/main/docs"
  );
  assert.equal(
    PROJECT_ROADMAP_URL,
    "https://github.com/prsmith777/ALPR-Database-Community/blob/main/docs/COMMUNITY_PRODUCT_ROADMAP.md"
  );
  assert.equal(
    PROJECT_RELEASES_URL,
    "https://github.com/prsmith777/ALPR-Database-Community/releases"
  );
});
