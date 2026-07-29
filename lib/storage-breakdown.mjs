import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const HOST_STORAGE_SNAPSHOT_SCHEMA_VERSION = 1;
export const DEFAULT_HOST_SNAPSHOT_MAX_AGE_SECONDS = 900;
export const DEFAULT_HOST_SNAPSHOT_FUTURE_TOLERANCE_SECONDS = 300;
export const STORAGE_BREAKDOWN_CACHE_MS = 60_000;
export const STORAGE_TREE_MAX_FILES = 250_000;
export const STORAGE_TREE_MAX_DEPTH = 32;
export const STORAGE_TREE_TIME_BUDGET_MS = 30_000;
const BREAKDOWN_CACHE = Symbol.for("alpr.storage.breakdown.cache.v1");

function cache(host = globalThis) {
  if (!host[BREAKDOWN_CACHE]) host[BREAKDOWN_CACHE] = new Map();
  return host[BREAKDOWN_CACHE];
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return parsed;
}

function optionalDate(value, label) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be an ISO date`);
  return date.toISOString();
}

export function normalizeHostStorageSnapshot(value = {}, {
  now = new Date(),
  maxAgeSeconds = DEFAULT_HOST_SNAPSHOT_MAX_AGE_SECONDS,
  futureToleranceSeconds = DEFAULT_HOST_SNAPSHOT_FUTURE_TOLERANCE_SECONDS,
} = {}) {
  if (Number(value.schemaVersion) !== HOST_STORAGE_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Host storage snapshot schemaVersion must be ${HOST_STORAGE_SNAPSHOT_SCHEMA_VERSION}`);
  }
  const measuredAt = optionalDate(value.measuredAt, "Host snapshot measuredAt");
  if (!measuredAt) throw new Error("Host snapshot measuredAt is required");
  const signedAgeSeconds = Math.floor((new Date(now).getTime() - new Date(measuredAt).getTime()) / 1000);
  if (signedAgeSeconds < -Math.max(0, Number(futureToleranceSeconds) || DEFAULT_HOST_SNAPSHOT_FUTURE_TOLERANCE_SECONDS)) {
    throw new Error("Host storage snapshot is materially future-dated");
  }
  const ageSeconds = Math.max(0, signedAgeSeconds);
  if (ageSeconds > Math.max(60, Number(maxAgeSeconds) || DEFAULT_HOST_SNAPSHOT_MAX_AGE_SECONDS)) {
    throw new Error("Host storage snapshot is stale");
  }
  const docker = value.docker || {};
  const backups = value.backups || {};
  const imagesBytes = nonNegativeInteger(docker.imagesBytes ?? 0, "Docker imagesBytes");
  const containersBytes = nonNegativeInteger(docker.containersBytes ?? 0, "Docker containersBytes");
  const buildCacheBytes = nonNegativeInteger(docker.buildCacheBytes ?? 0, "Docker buildCacheBytes");
  const declaredDockerTotal = docker.totalBytes == null
    ? imagesBytes + containersBytes + buildCacheBytes
    : nonNegativeInteger(docker.totalBytes, "Docker totalBytes");
  if (declaredDockerTotal !== imagesBytes + containersBytes + buildCacheBytes) {
    throw new Error("Docker totalBytes must equal images, containers, and build cache bytes");
  }
  return {
    schemaVersion: HOST_STORAGE_SNAPSHOT_SCHEMA_VERSION,
    measuredAt,
    ageSeconds,
    docker: {
      imagesBytes,
      containersBytes,
      buildCacheBytes,
      bytes: declaredDockerTotal,
      note: "Docker volumes are excluded to avoid double-counting application storage and PostgreSQL.",
    },
    backups: {
      bytes: nonNegativeInteger(backups.bytes ?? 0, "Backup bytes"),
      count: nonNegativeInteger(backups.count ?? 0, "Backup count"),
      latestVerifiedAt: optionalDate(backups.latestVerifiedAt, "Backup latestVerifiedAt"),
    },
  };
}

export async function readHostStorageSnapshot({
  snapshotPath,
  read = readFile,
  fileStat = lstat,
  now = new Date(),
  maxAgeSeconds = DEFAULT_HOST_SNAPSHOT_MAX_AGE_SECONDS,
  futureToleranceSeconds = DEFAULT_HOST_SNAPSHOT_FUTURE_TOLERANCE_SECONDS,
} = {}) {
  if (!snapshotPath) return { snapshot: null, error: "Host storage snapshot is not configured." };
  try {
    const info = await fileStat(snapshotPath);
    if (!info?.isFile?.() || info?.isSymbolicLink?.()) throw new Error("Host storage snapshot is not a regular file");
    const parsed = JSON.parse(await read(snapshotPath, "utf8"));
    return { snapshot: normalizeHostStorageSnapshot(parsed, { now, maxAgeSeconds, futureToleranceSeconds }), error: null };
  } catch (error) {
    return { snapshot: null, error: String(error?.message || error).slice(0, 500) };
  }
}

export async function measureStorageTree(rootPath, {
  readDirectory = readdir,
  pathStat = lstat,
  maxFiles = STORAGE_TREE_MAX_FILES,
  maxDepth = STORAGE_TREE_MAX_DEPTH,
  timeBudgetMs = STORAGE_TREE_TIME_BUDGET_MS,
  clock = () => Date.now(),
} = {}) {
  const pending = [{ directory: rootPath, depth: 0 }];
  const startedAt = clock();
  let bytes = 0;
  let count = 0;
  let skipped = 0;
  let errorCount = 0;
  const partialReasons = new Set();
  while (pending.length > 0) {
    if (clock() - startedAt >= Math.max(1, Number(timeBudgetMs) || STORAGE_TREE_TIME_BUDGET_MS)) {
      partialReasons.add("time-budget");
      break;
    }
    const { directory, depth } = pending.pop();
    let entries;
    try {
      entries = await readDirectory(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") errorCount += 1;
      continue;
    }
    for (const entry of entries) {
      if (clock() - startedAt >= Math.max(1, Number(timeBudgetMs) || STORAGE_TREE_TIME_BUDGET_MS)) {
        partialReasons.add("time-budget");
        break;
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink?.()) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory?.()) {
        if (depth >= Math.max(1, Number(maxDepth) || STORAGE_TREE_MAX_DEPTH)) {
          skipped += 1;
          partialReasons.add("max-depth");
        } else {
          pending.push({ directory: candidate, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile?.()) {
        skipped += 1;
        continue;
      }
      try {
        if (count >= Math.max(1, Number(maxFiles) || STORAGE_TREE_MAX_FILES)) {
          partialReasons.add("max-files");
          break;
        }
        const info = await pathStat(candidate);
        if (!info?.isFile?.() || info?.isSymbolicLink?.()) {
          skipped += 1;
          continue;
        }
        bytes += nonNegativeInteger(info.size, "Storage file size");
        count += 1;
      } catch {
        errorCount += 1;
      }
    }
    if (partialReasons.has("time-budget") || partialReasons.has("max-files")) break;
  }
  return {
    bytes,
    count,
    skipped,
    errorCount,
    partial: partialReasons.size > 0,
    partialReasons: [...partialReasons],
  };
}

export async function collectStorageBreakdown({
  storagePath,
  databaseBytes = null,
  hostSnapshotPath = process.env.STORAGE_HOST_SNAPSHOT_PATH || "",
  now = new Date(),
  measureTree = measureStorageTree,
  loadHostSnapshot = readHostStorageSnapshot,
  cacheHost = globalThis,
  cacheMilliseconds = STORAGE_BREAKDOWN_CACHE_MS,
  force = false,
} = {}) {
  if (!storagePath) throw new Error("Storage path is required for category measurement");
  const cacheKey = `${path.resolve(storagePath)}\0${hostSnapshotPath}`;
  const entries = cache(cacheHost);
  const existing = entries.get(cacheKey);
  const currentMs = new Date(now).getTime();
  if (!force && existing?.value && currentMs - existing.measuredMs < cacheMilliseconds) return existing.value;
  if (!force && existing?.promise) return existing.promise;
  const measurement = (async () => {
  const [sourceImages, thumbnails, derivedVehicleImages, host] = await Promise.all([
    measureTree(path.join(storagePath, "images")),
    measureTree(path.join(storagePath, "thumbnails")),
    measureTree(path.join(storagePath, "derived")),
    loadHostSnapshot({ snapshotPath: hostSnapshotPath, now }),
  ]);
  const errors = [];
  for (const [label, measurement] of [
    ["source images", sourceImages],
    ["thumbnails", thumbnails],
    ["derived vehicle images", derivedVehicleImages],
  ]) {
    if (measurement.errorCount > 0) errors.push(`${label}: ${measurement.errorCount} entries could not be measured`);
    if (measurement.skipped > 0) errors.push(`${label}: ${measurement.skipped} non-regular or symbolic-link entries were skipped`);
    if (measurement.partial) errors.push(`${label}: partial measurement (${measurement.partialReasons.join(", ")})`);
  }
  if (host.error) errors.push(host.error);
  const value = {
    measuredAt: new Date(now).toISOString(),
    sourceImages,
    thumbnails,
    derivedVehicleImages,
    database: { bytes: databaseBytes == null ? null : nonNegativeInteger(databaseBytes, "Database bytes") },
    docker: host.snapshot?.docker || null,
    backups: host.snapshot?.backups || null,
    hostSnapshotMeasuredAt: host.snapshot?.measuredAt || null,
    errors,
  };
    entries.set(cacheKey, { value, measuredMs: currentMs, promise: null });
    return value;
  })().catch((error) => {
    entries.delete(cacheKey);
    throw error;
  });
  entries.set(cacheKey, { value: null, measuredMs: currentMs, promise: measurement });
  return measurement;
}

export function invalidateStorageBreakdownCache({ storagePath, hostSnapshotPath = process.env.STORAGE_HOST_SNAPSHOT_PATH || "", cacheHost = globalThis } = {}) {
  if (!storagePath) return;
  cache(cacheHost).delete(`${path.resolve(storagePath)}\0${hostSnapshotPath}`);
}

export const storageBreakdownInternals = Object.freeze({ BREAKDOWN_CACHE, cache, nonNegativeInteger, optionalDate });
