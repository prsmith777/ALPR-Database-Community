import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
    const path = directory + entry.name;
    if (entry.isDirectory()) files.push(...await filesIn(path + "/"));
    else if (/\.(m?js|jsx|tsx?|md)$/.test(path)) files.push(path);
  }
  return files;
}

test("application, deployment examples, and user guidance contain no retired identity engine", async () => {
  const files = [
    ".env.example", "docker-compose.yml", "docker-compose.without-database.yml", "README.md",
    ...await filesIn("lib/"), ...await filesIn("app/"),
    ...await filesIn("components/"), ...await filesIn("docs/"),
  ];
  const retired = /VISUAL_INDEX_|visualIndex|capture_assets|camera_visual_profiles|vehicle_cluster_assignments|vehicle_clusters|vehicle_match_feedback|v1_primary|v2_shadow|vehicle-reid-v2-conversion|visual-index-(worker|runtime|settings|startup)|ReID\s*V1/i;
  for (const path of files) {
    assert.doesNotMatch(await readFile(new URL(path, root), "utf8"), retired, path);
  }
});

test("schema only retires the old engine and cannot drop original application records", async () => {
  const schema = await readFile(new URL("schema.sql", root), "utf8");
  const migration = await readFile(new URL("migrations.sql", root), "utf8");
  const retiredCreation = /CREATE\s+TABLE(?:\s+IF NOT EXISTS)?\s+public\.(?:capture_assets|camera_visual_profiles|vehicle_clusters|vehicle_cluster_assignments|vehicle_match_feedback|vehicle_reid_v2_conversion_\w+)/i;
  assert.doesNotMatch(schema + migration, retiredCreation);
  assert.doesNotMatch(migration, /DROP\s+TABLE(?:\s+IF EXISTS)?\s+public\.(?:plate_reads|plates|users|tags|plate_tags)\b/i);
  assert.match(migration, /2026092701_native_reid/);
});
