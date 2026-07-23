import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("middleware contains no whitelist, request IP, or forwarded-header authentication", async () => {
  const middleware = await fs.readFile("middleware.js", "utf8");
  const helper = await fs.readFile("lib/middleware-auth.mjs", "utf8");
  const source = `${middleware}\n${helper}`;

  assert.equal(source.includes("verify-whitelist"), false);
  assert.equal(source.includes("request.ip"), false);
  assert.equal(source.includes("Object.fromEntries(request.headers)"), false);
});

test("plate-read route delegates to the authentication-first wrapper", async () => {
  const source = await fs.readFile("app/api/plate-reads/route.js", "utf8");
  assert.match(source, /createIntegrationRouteHandler\(processPlateRead\)/);
  assert.equal(source.includes("await req.json()"), false);
  assert.equal(source.includes("Received plate read data"), false);
  assert.equal(source.includes("details: error.message"), false);
});

test("committed plate reads cannot fail because cache revalidation lacks a browser session", async () => {
  const source = await fs.readFile("app/api/plate-reads/route.js", "utf8");

  assert.equal(source.includes('from "@/app/actions"'), false);
  assert.match(source, /import \{ revalidatePath \} from "next\/cache"/);
  assert.match(source, /revalidatePath\("\/live_feed"\)/);

  const start = source.indexOf('revalidatePath("/live_feed")');
  const revalidationBlock = source.slice(
    start,
    source.indexOf("return Response.json", start)
  );
  assert.equal(revalidationBlock.includes("throw error"), false);
  assert.match(revalidationBlock, /Plate page revalidation failed/);
});

test("every non-public server action verifies its own session", async () => {
  const source = await fs.readFile("app/actions.js", "utf8");
  const declaration =
    /export async function\s+([A-Za-z0-9_]+)\s*\([\s\S]*?\)\s*\{/g;
  const publicActions = new Set(["loginAction", "logoutAction"]);
  const checked = [];

  for (const match of source.matchAll(declaration)) {
    const name = match[1];
    if (publicActions.has(name)) continue;

    const bodyStart = match.index + match[0].length;
    const bodyPrefix = source.slice(bodyStart, bodyStart + 120);
    assert.match(
      bodyPrefix,
      /^\s*(?:await require(?:AuthenticatedSession|Permission)\([^;]*\);|const principal = await require(?:AuthenticatedSession|Permission)\([^;]*\);)/,
      `${name} must authenticate before doing any work`
    );
    checked.push(name);
  }

  assert.ok(checked.length >= 40, "expected to inspect the complete action set");
  assert.match(
    source,
    /authenticate:\s*\(\) => requirePermission\("maintenance\.manage"\)/,
    "update and migration actions must retain their internal authentication"
  );
});

test("public health checks do not disclose database errors", async () => {
  const source = await fs.readFile("app/api/health-check/route.js", "utf8");

  assert.equal(source.includes("error.message"), false);
  assert.match(source, /\{ status: "error" \}/);
  assert.match(source, /\{ status: 503 \}/);
});

test("baseline browser security headers are configured", async () => {
  const source = await fs.readFile("next.config.js", "utf8");

  for (const header of [
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
  ]) {
    assert.ok(source.includes(header), `missing ${header}`);
  }
});

test("upstream telemetry, training uploads, and update polling are removed", async () => {
  const activeSources = await Promise.all(
    [
      "app/actions.js",
      "app/dashboard/page.jsx",
      "app/layout.jsx",
      "app/settings/SettingsForm.jsx",
      "lib/settings.js",
      "lib/version.js",
    ].map((file) => fs.readFile(file, "utf8"))
  );
  const source = activeSources.join("\n");

  for (const retiredReference of [
    "alpr-metrics.algertc.workers.dev",
    "alpr-training.algertc.workers.dev",
    "sendMetricsUpdate",
    "TrainingDataHandler",
    "generateTrainingData",
    "processTrainingData",
    "getVersionInfo",
  ]) {
    assert.equal(
      source.includes(retiredReference),
      false,
      `retired external path remains: ${retiredReference}`
    );
  }

  for (const retiredFile of [
    "components/MetricsHandler.jsx",
    "components/TrainingHandler.jsx",
    "components/UpdateAlert.jsx",
    "app/training/TrainingControl.jsx",
    "app/training/page.jsx",
    "lib/training.js",
  ]) {
    await assert.rejects(fs.access(retiredFile), { code: "ENOENT" });
  }
});

test("legacy upstream installer and updater scripts are retired", async () => {
  for (const retiredFile of [
    "install.sh",
    "install.ps1",
    "update.sh",
    "update.ps1",
  ]) {
    await assert.rejects(fs.access(retiredFile), { code: "ENOENT" });
  }
});

test("the production image uses a supported non-root deterministic runtime", async () => {
  const dockerfile = await fs.readFile("Dockerfile", "utf8");
  const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
  const openvinoInstaller = await fs.readFile("scripts/install-openvino-runtime.mjs", "utf8");

  assert.match(dockerfile, /^FROM node:24-bookworm AS builder/m);
  assert.match(dockerfile, /^FROM node:24-bookworm-slim$/m);
  assert.match(dockerfile, /yarn install --frozen-lockfile --ignore-scripts/);
  assert.match(
    dockerfile,
    /PREBUILDS_ONLY=1 node \.\.\/node-gyp-build\/build-test\.js/,
  );
  assert.match(dockerfile, /node scripts\/install-openvino-runtime\.mjs/);
  assert.equal(dockerfile.includes("yarn add"), false);
  assert.equal(packageJson.dependencies["openvino-node"], "2025.4.0");
  assert.match(openvinoInstaller, /storage\.openvinotoolkit\.org/);
  assert.match(openvinoInstaller, /RUNTIME_SHA256 = "[0-9a-f]{64}"/);
  assert.match(openvinoInstaller, /MAX_ARCHIVE_BYTES/);
  assert.match(openvinoInstaller, /packageJson\.version !== "2025\.4\.0"/);
  assert.equal(
    dockerfile.match(/NEXT_TELEMETRY_DISABLED=1/g)?.length,
    2,
    "Next.js telemetry must be disabled in both image stages"
  );
  assert.match(dockerfile, /^USER node$/m);
  assert.equal(packageJson.engines.node, ">=24.0.0 <25");
  assert.equal(
    packageJson.scripts.test.includes("--experimental-default-type=module"),
    false
  );
});

test("Compose deployments require private credentials and keep Postgres local", async () => {
  const mainCompose = await fs.readFile("docker-compose.yml", "utf8");
  const dbOnlyCompose = await fs.readFile("docker-compose-dbonly.yml", "utf8");
  const externalCompose = await fs.readFile(
    "docker-compose.without-database.yml",
    "utf8"
  );
  const envExample = await fs.readFile(".env.example", "utf8");
  const gitignore = await fs.readFile(".gitignore", "utf8");

  for (const compose of [mainCompose, dbOnlyCompose, externalCompose]) {
    assert.equal(compose.includes("PASSWORD=password"), false);
    assert.match(compose, /\$\{DB_PASSWORD:\?/);
  }

  assert.match(mainCompose, /ADMIN_PASSWORD:\s+"\$\{ADMIN_PASSWORD:\?/);
  assert.match(mainCompose, /SESSION_COOKIE_SECURE:\s+"\$\{SESSION_COOKIE_SECURE:-false\}"/);
  assert.match(externalCompose, /SESSION_COOKIE_SECURE:\s+"\$\{SESSION_COOKIE_SECURE:-false\}"/);
  assert.match(mainCompose, /127\.0\.0\.1:\$\{DB_PORT:-5432\}:5432/);
  assert.match(dbOnlyCompose, /127\.0\.0\.1:\$\{DB_PORT:-5432\}:5432/);
  assert.match(mainCompose, /ALPR_APP_IMAGE:-alpr-dashboard:local/);
  assert.match(externalCompose, /ALPR_APP_IMAGE:-alpr-dashboard:local/);
  assert.match(mainCompose, /pull_policy:\s*never/);
  assert.match(externalCompose, /pull_policy:\s*never/);
  assert.equal(mainCompose.includes("algertc/alpr-dashboard"), false);
  assert.equal(externalCompose.includes("algertc/alpr-dashboard"), false);
  assert.equal(externalCompose.includes("depends_on:"), false);
  assert.match(externalCompose, /DB_HOST:\s+"\$\{DB_HOST:\?/);

  assert.match(envExample, /^ADMIN_PASSWORD=$/m);
  assert.match(envExample, /^DB_PASSWORD=$/m);
  assert.match(envExample, /^SESSION_COOKIE_SECURE=false$/m);
  assert.match(gitignore, /^\.env\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);

});

test("the health check uses the supported runtime and fails honestly", async () => {
  const workflow = await fs.readFile(".github/workflows/health-check.yml", "utf8");

  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /yarn install --frozen-lockfile/);
  assert.match(workflow, /MQTT_STATUS/);
  assert.match(workflow, /instead of 401/);
  assert.equal(workflow.includes("if: always()"), false);
});
