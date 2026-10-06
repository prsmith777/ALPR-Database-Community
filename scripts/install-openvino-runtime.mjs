import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const RUNTIMES = Object.freeze({
  linux: {
    sha256: "ec2cfcd283b9d2183899ea9a82be543d1144dae0fae58e6ee9894ce1b43730a6",
    files: ["ov_node_addon.node", "libopenvino.so", "libopenvino_intel_cpu_plugin.so"],
  },
  win32: {
    sha256: "d344132e42852a43ad8a1f7a5e91007fc31739b7b6cd6050cc5f3d397223cd2e",
    files: ["ov_node_addon.node", "openvino.dll", "openvino_intel_cpu_plugin.dll"],
  },
});

function runtimeForHost(platform = process.platform, arch = process.arch) {
  if (!RUNTIMES[platform] || arch !== "x64") {
    throw new Error(`Pinned OpenVINO runtime supports linux/x64 and win32/x64, received ${platform}/${arch}`);
  }
  return {
    ...RUNTIMES[platform],
    url: new URL(`https://storage.openvinotoolkit.org/repositories/openvino/nodejs_bindings/2025.4.0/${platform}/openvino_nodejs_bindings_${platform}_2025.4.0_x64.tar.gz`),
  };
}
const RUNTIME_URL = runtimeForHost().url;
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_ATTEMPTS = 4;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const TRANSIENT_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal || `exit ${code}`})`));
    });
  });
}

function assertSupportedBuildHost() {
  runtimeForHost();
  if (RUNTIME_URL.protocol !== "https:" || RUNTIME_URL.hostname !== "storage.openvinotoolkit.org") {
    throw new Error("Unexpected OpenVINO runtime origin");
  }
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

function isTransientNetworkError(error) {
  let current = error;
  while (current) {
    if (["AbortError", "TimeoutError"].includes(current.name)) return true;
    if (TRANSIENT_NETWORK_CODES.has(current.code)) return true;
    current = current.cause;
  }
  return false;
}

function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function downloadRuntimeArchive(archivePath, options = {}) {
  const fetchImplementation = options.fetchImplementation || fetch;
  const sleep = options.sleep || delay;
  const attempts = options.attempts || DOWNLOAD_ATTEMPTS;
  const timeoutMs = options.timeoutMs || DOWNLOAD_TIMEOUT_MS;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await rm(archivePath, { force: true });
    try {
      const response = await fetchImplementation(RUNTIME_URL, {
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok || !response.body) {
        const error = new Error(`OpenVINO runtime download failed with HTTP ${response.status}`);
        error.retryable = retryableStatus(response.status);
        throw error;
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
      return received;
    } catch (error) {
      await rm(archivePath, { force: true });
      if (attempt === attempts || (!error.retryable && !isTransientNetworkError(error))) throw error;
      const waitMs = attempt * 2_000;
      console.warn(`OpenVINO runtime download attempt ${attempt} failed; retrying in ${waitMs / 1000} seconds.`);
      await sleep(waitMs);
    }
  }
  throw new Error("OpenVINO runtime download attempts were exhausted");
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
    const received = await downloadRuntimeArchive(archivePath);
    const actualHash = await sha256(archivePath);
    if (actualHash !== runtimeForHost().sha256) {
      throw new Error(`OpenVINO runtime checksum mismatch: ${actualHash}`);
    }

    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await run("tar", [
      "--extract",
      "--gzip",
      "--file", archivePath,
      "--directory", destination,
      ...(process.platform === "linux" ? ["--no-same-owner", "--no-same-permissions"] : []),
    ]);
    for (const expected of runtimeForHost().files) {
      await fs.promises.access(path.join(destination, expected), fs.constants.R_OK);
    }
    console.log(`Installed checksum-verified OpenVINO ${packageJson.version} runtime (${received} bytes).`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export const openvinoRuntimeInstallerInternals = Object.freeze({
  DOWNLOAD_ATTEMPTS,
  DOWNLOAD_TIMEOUT_MS,
  RUNTIME_URL,
  runtimeForHost,
  downloadRuntimeArchive,
  isTransientNetworkError,
  retryableStatus,
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
