import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openvinoRuntimeInstallerInternals as internals } from "../scripts/install-openvino-runtime.mjs";

test("OpenVINO download retries a transient DNS failure and replaces partial artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openvino-download-"));
  const archive = join(directory, "runtime.tar.gz");
  const waits = [];
  let calls = 0;
  try {
    const received = await internals.downloadRuntimeArchive(archive, {
      attempts: 3,
      timeoutMs: 1_000,
      sleep: async (milliseconds) => waits.push(milliseconds),
      fetchImplementation: async () => {
        calls += 1;
        if (calls === 1) {
          const cause = Object.assign(new Error("temporary DNS failure"), { code: "ENOTFOUND" });
          throw new TypeError("fetch failed", { cause });
        }
        return new Response(Buffer.from("verified archive bytes"), {
          status: 200,
          headers: { "content-length": "22" },
        });
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(waits, [2_000]);
    assert.equal(received, 22);
    assert.equal(await readFile(archive, "utf8"), "verified archive bytes");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenVINO download does not retry a permanent client response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openvino-download-"));
  const archive = join(directory, "runtime.tar.gz");
  let calls = 0;
  try {
    await assert.rejects(
      internals.downloadRuntimeArchive(archive, {
        attempts: 4,
        sleep: async () => assert.fail("permanent responses must not wait for a retry"),
        fetchImplementation: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      }),
      /HTTP 404/
    );
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
