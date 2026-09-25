import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { COMMUNITY_UPGRADE_BASELINES } from "../scripts/test-community-upgrade-matrix.mjs";

test("the Community upgrade matrix pins the supported clean-history baselines", () => {
  assert.deepEqual(
    COMMUNITY_UPGRADE_BASELINES.map(({ version, commit, sourceMajor }) => ({
      version,
      commit,
      sourceMajor,
    })),
    [
      {
        version: "0.1.20",
        commit: "4cb70c2c5cbe24c7451e5c468692250331b7cbd0",
        sourceMajor: 13,
      },
      {
        version: "0.1.21",
        commit: "c783fcafc62396f437c4fa811ce33bce658119b8",
        sourceMajor: 17,
      },
      {
        version: "0.1.22",
        commit: "316742ebbd6ba6fc2e2135a4b5c96b61bc160859",
        sourceMajor: 17,
      },
    ]
  );
  assert.equal(
    COMMUNITY_UPGRADE_BASELINES.filter(({ exerciseRecovery }) => exerciseRecovery).length,
    1
  );
  assert.equal(
    COMMUNITY_UPGRADE_BASELINES.find(({ exerciseRecovery }) => exerciseRecovery)?.version,
    "0.1.22"
  );
});

test("the package and migration guide expose the isolated upgrade acceptance command", async () => {
  const [packageText, guide, harness] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../docs/MIGRATION_GUIDE.md", import.meta.url), "utf8"),
    readFile(new URL("../scripts/test-community-upgrade-matrix.mjs", import.meta.url), "utf8"),
  ]);
  const packageDefinition = JSON.parse(packageText);
  assert.equal(
    packageDefinition.scripts["test:community-upgrades"],
    "node scripts/test-community-upgrade-matrix.mjs"
  );
  assert.match(guide, /npm run test:community-upgrades/);
  assert.match(guide, /random\s+loopback ports/i);
  assert.match(harness, /127\.0\.0\.1::5432/);
  assert.match(harness, /alpr-upgrade-/);
  assert.doesNotMatch(harness, /docker compose (?:down|stop)/i);
});
