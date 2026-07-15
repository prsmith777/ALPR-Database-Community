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
