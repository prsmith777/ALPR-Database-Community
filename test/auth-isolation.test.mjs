import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getAuthConfig,
  resetAuthStateForTests,
  updateAuthConfig,
  verifyApiKey,
} from "../lib/auth.js";

async function readIfPresent(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

test("authentication tests require an isolated file and preserve production auth", async () => {
  const productionAuth = path.join(process.cwd(), "auth", "auth.json");
  const before = await readIfPresent(productionAuth);
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "alpr-auth-test-")
  );
  const temporaryAuth = path.join(temporaryDirectory, "auth.json");
  const originalEnvironment = {
    NODE_ENV: process.env.NODE_ENV,
    ALPR_AUTH_FILE_PATH: process.env.ALPR_AUTH_FILE_PATH,
  };

  try {
    process.env.NODE_ENV = "test";
    delete process.env.ALPR_AUTH_FILE_PATH;
    resetAuthStateForTests();
    await assert.rejects(getAuthConfig(), /ALPR_AUTH_FILE_PATH is required/);

    process.env.ALPR_AUTH_FILE_PATH = temporaryAuth;
    await fs.writeFile(
      temporaryAuth,
      JSON.stringify({
        password: "unused-test-hash",
        apiKey: "isolated-api-key",
        sessions: {},
      })
    );
    resetAuthStateForTests();

    const config = await getAuthConfig();
    assert.equal(config.apiKey, "isolated-api-key");
    assert.equal(await verifyApiKey("isolated-api-key"), true);
    await assert.doesNotReject(verifyApiKey("short"));
    assert.equal(await verifyApiKey("short"), false);

    config.sessions["temporary-session"] = { expiresAt: Date.now() + 1000 };
    await updateAuthConfig(config);
    const written = JSON.parse(await fs.readFile(temporaryAuth, "utf8"));
    assert.ok(written.sessions["temporary-session"]);
  } finally {
    resetAuthStateForTests();
    if (originalEnvironment.NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnvironment.NODE_ENV;
    }
    if (originalEnvironment.ALPR_AUTH_FILE_PATH === undefined) {
      delete process.env.ALPR_AUTH_FILE_PATH;
    } else {
      process.env.ALPR_AUTH_FILE_PATH =
        originalEnvironment.ALPR_AUTH_FILE_PATH;
    }
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }

  const after = await readIfPresent(productionAuth);
  if (before === null) {
    assert.equal(after, null);
  } else {
    assert.deepEqual(after, before);
  }
});
