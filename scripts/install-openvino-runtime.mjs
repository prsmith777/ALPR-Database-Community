import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";

const RUNTIME_URL = new URL(
  "https://storage.openvinotoolkit.org/repositories/openvino/nodejs_bindings/2025.4.0/linux/openvino_nodejs_bindings_linux_2025.4.0_x64.tar.gz"
);
const RUNTIME_SHA256 = "ec2cfcd283b9d2183899ea9a82be543d1144dae0fae58e6ee9894ce1b43730a6";
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal || `exit ${code}`})`));
    });
  });
}

function assertSupportedBuildHost() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(`Pinned OpenVINO runtime supports linux/x64 builds, received ${process.platform}/${process.arch}`);
  }
  if (RUNTIME_URL.protocol !== "https:" || RUNTIME_URL.hostname !== "storage.openvinotoolkit.org") {
    throw new Error("Unexpected OpenVINO runtime origin");
  }
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function main() {
  assertSupportedBuildHost();
  const packageRoot = path.resolve("node_modules", "openvino-node");
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (packageJson.version !== "2025.4.0") {
    throw new Error(`OpenVINO package/runtime mismatch: ${packageJson.version}`);
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "openvino-runtime-"));
  const archivePath = path.join(temporaryDirectory, "runtime.tar.gz");
  const destination = path.join(packageRoot, "bin");
  try {
    const response = await fetch(RUNTIME_URL, { redirect: "error" });
    if (!response.ok || !response.body) {
      throw new Error(`OpenVINO runtime download failed with HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
      throw new Error("OpenVINO runtime archive exceeds the size limit");
    }
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(received <= MAX_ARCHIVE_BYTES ? null : new Error("OpenVINO runtime archive exceeds the size limit"), chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(archivePath, { mode: 0o600 }));
    const actualHash = await sha256(archivePath);
    if (actualHash !== RUNTIME_SHA256) {
      throw new Error(`OpenVINO runtime checksum mismatch: ${actualHash}`);
    }

    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await run("tar", [
      "--extract",
      "--gzip",
      "--file", archivePath,
      "--directory", destination,
      "--no-same-owner",
      "--no-same-permissions",
    ]);
    for (const expected of ["ov_node_addon.node", "libopenvino.so", "libopenvino_intel_cpu_plugin.so"]) {
      await fs.promises.access(path.join(destination, expected), fs.constants.R_OK);
    }
    console.log(`Installed checksum-verified OpenVINO ${packageJson.version} runtime (${received} bytes).`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
