import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensurePrivateDirectory,
  writePrivateFile,
} from "../lib/private-file.mjs";

test("private directories and files use owner-only permissions on POSIX", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits are enforced by the Linux deployment");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpr-private-file-"));
  const directory = path.join(root, "secrets");
  const file = path.join(directory, "credentials.json");

  try {
    await ensurePrivateDirectory(directory);
    await writePrivateFile(file, "private");

    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
