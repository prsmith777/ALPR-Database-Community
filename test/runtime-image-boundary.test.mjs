import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("production image copies only standalone runtime artifacts", async () => {
  const [dockerfile, nextConfig] = await Promise.all([
    readFile(new URL("Dockerfile", root), "utf8"),
    readFile(new URL("next.config.js", root), "utf8"),
  ]);

  assert.match(nextConfig, /output:\s*["']standalone["']/);
  assert.match(dockerfile, /\/app\/\.next\/standalone\s+\.\//);
  assert.match(dockerfile, /\/app\/\.next\/static\s+\.\/\.next\/static/);
  assert.match(dockerfile, /\/app\/public\s+\.\/public/);
  assert.match(dockerfile, /\/app\/models\/visual-search\s+\.\/models\/visual-search/);
  assert.match(dockerfile, /openvino-runtime-probe\.cjs/);
  assert.match(dockerfile, /RUN node \/tmp\/openvino-runtime-probe\.cjs/);
  assert.match(dockerfile, /rm -f \/tmp\/openvino-runtime-probe\.cjs/);
  assert.doesNotMatch(dockerfile, /COPY\s+--from=builder[^\n]*\/app\s+\/app(?:\s|$)/);
  assert.match(dockerfile, /CMD\s+\["node",\s*"server\.js"\]/);
});

test("CI enforces the runtime image and empty-database contracts", async () => {
  const [ci, health, verifier, inferenceProbe] = await Promise.all([
    readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
    readFile(new URL(".github/workflows/health-check.yml", root), "utf8"),
    readFile(new URL("scripts/verify-runtime-image.mjs", root), "utf8"),
    readFile(new URL("scripts/openvino-runtime-probe.cjs", root), "utf8"),
  ]);

  assert.match(ci, /verify-runtime-image\.mjs\s+alpr-ci:/);
  assert.match(health, /0\|0\|0\|0\|0\|0/);
  assert.match(health, /codex_staging_fixture_sets/);
  assert.match(health, /codex_staging_fixture_manifest/);
  assert.match(health, /SELECT update1 FROM public\.devmgmt WHERE id = 1/);
  assert.match(verifier, /"\/app\/test"/);
  assert.match(verifier, /"\/app\/scripts"/);
  assert.match(verifier, /"\/app\/test-payload\.json"/);
  assert.match(verifier, /"\/app\/multi-ai-payload\.json"/);
  assert.match(verifier, /openvino-runtime-probe\.cjs/);
  assert.match(verifier, /--network",\s*"none"/);
  assert.match(inferenceProbe, /openvino-node/);
  assert.match(inferenceProbe, /compileModelSync\(model, "CPU"\)/);
  assert.match(inferenceProbe, /infer\(/);
});

test("fresh installs bypass the legacy image-migration workflow", async () => {
  const [schema, migrations] = await Promise.all([
    readFile(new URL("schema.sql", root), "utf8"),
    readFile(new URL("migrations.sql", root), "utf8"),
  ]);

  assert.match(schema, /update1 BOOLEAN DEFAULT TRUE/);
  assert.match(
    schema,
    /INSERT INTO public\.devmgmt \(id, update1\)\s+SELECT 1, true/
  );
  assert.match(migrations, /update1 BOOLEAN DEFAULT FALSE/);
  assert.match(
    migrations,
    /INSERT INTO devmgmt \(id, update1\)\s+SELECT 1, false/
  );
});
