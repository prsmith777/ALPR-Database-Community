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
      /^\s*await requireAuthenticatedSession\(\);/,
      `${name} must authenticate before doing any work`
    );
    checked.push(name);
  }

  assert.ok(checked.length >= 40, "expected to inspect the complete action set");
  assert.match(
    source,
    /authenticate:\s*requireAuthenticatedSession/,
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

test("the production image uses a supported non-root deterministic runtime", async () => {
  const dockerfile = await fs.readFile("Dockerfile", "utf8");
  const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));

  assert.match(dockerfile, /^FROM node:24-bookworm AS builder/m);
  assert.match(dockerfile, /^FROM node:24-bookworm-slim$/m);
  assert.match(dockerfile, /yarn install --frozen-lockfile/);
  assert.equal(dockerfile.includes("yarn add"), false);
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
  const installSh = await fs.readFile("install.sh", "utf8");
  const installPs1 = await fs.readFile("install.ps1", "utf8");
  const updateSh = await fs.readFile("update.sh", "utf8");
  const updatePs1 = await fs.readFile("update.ps1", "utf8");

  for (const compose of [mainCompose, dbOnlyCompose, externalCompose]) {
    assert.equal(compose.includes("PASSWORD=password"), false);
    assert.match(compose, /\$\{DB_PASSWORD:\?/);
  }

  assert.match(mainCompose, /ADMIN_PASSWORD:\s+"\$\{ADMIN_PASSWORD:\?/);
  assert.match(mainCompose, /127\.0\.0\.1:\$\{DB_PORT:-5432\}:5432/);
  assert.match(dbOnlyCompose, /127\.0\.0\.1:\$\{DB_PORT:-5432\}:5432/);
  assert.equal(externalCompose.includes("depends_on:"), false);
  assert.match(externalCompose, /DB_HOST:\s+"\$\{DB_HOST:\?/);

  assert.match(envExample, /^ADMIN_PASSWORD=$/m);
  assert.match(envExample, /^DB_PASSWORD=$/m);
  assert.match(gitignore, /^\.env\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);

  for (const installer of [installSh, installPs1]) {
    assert.match(installer, /\.env/);
    assert.equal(installer.includes("ADMIN_PASSWORD=password"), false);
    assert.equal(installer.includes("POSTGRES_PASSWORD=password"), false);
  }
  assert.match(installSh, /chmod 600 \.env/);
  assert.match(updateSh, /write_migrated_env/);
  assert.match(updatePs1, /Write-MigratedEnvironment/);
});
