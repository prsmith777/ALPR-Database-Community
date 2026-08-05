import { lstat, open, rename, unlink } from "node:fs/promises";

export const HOST_STORAGE_SNAPSHOT_DIRECTORY = "/host-storage-snapshot";
export const HOST_STORAGE_SNAPSHOT_FILENAME = "storage-snapshot-v1.json";
export const HOST_STORAGE_SNAPSHOT_TEMP_FILENAME = ".storage-snapshot-v1.json.tmp";
export const HOST_STORAGE_SNAPSHOT_MAX_BYTES = 64 * 1024;

function safeBytes(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return parsed;
}

function requiredDate(value, label) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be an ISO date`);
  return parsed.toISOString();
}

function dockerVolumeName(builderContainer) {
  const matches = (builderContainer?.Mounts || []).filter((mount) =>
    mount?.Type === "volume" && mount?.Destination === "/var/lib/buildkit" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(String(mount?.Name || "")));
  if (matches.length !== 1) throw new Error("Attested BuildKit container must expose one fixed state volume");
  return matches[0].Name;
}

export function buildHostStorageSnapshot({ systemDf, builderContainer, backupArtifacts, measuredAt = new Date() } = {}) {
  const imagesBytes = safeBytes(systemDf?.LayersSize, "Docker LayersSize");
  const containersBytes = (systemDf?.Containers || []).reduce(
    (sum, container) => sum + safeBytes(container?.SizeRw ?? 0, "Docker container SizeRw"), 0);
  const volumeName = dockerVolumeName(builderContainer);
  const volumeMatches = (systemDf?.Volumes || []).filter((volume) => volume?.Name === volumeName);
  if (volumeMatches.length !== 1) throw new Error("Attested BuildKit state volume is absent or ambiguous");
  const buildCacheBytes = safeBytes(volumeMatches[0]?.UsageData?.Size, "BuildKit state volume size");

  const seenPhysicalFiles = new Set();
  let backupBytes = 0;
  let latestVerifiedAt = null;
  const artifacts = Array.isArray(backupArtifacts) ? backupArtifacts : [];
  for (const artifact of artifacts) {
    if (artifact?.verified !== true || Number(artifact?.linkCount) !== 1) {
      throw new Error("Every reported backup artifact must be verified and singly linked");
    }
    const physicalIdentity = `${safeBytes(artifact.device, "Backup device")}:${safeBytes(artifact.inode, "Backup inode")}`;
    if (seenPhysicalFiles.has(physicalIdentity)) throw new Error("Verified backup artifacts share a physical file");
    seenPhysicalFiles.add(physicalIdentity);
    backupBytes += safeBytes(artifact.bytes, "Backup artifact size");
    if (!Number.isSafeInteger(backupBytes)) throw new Error("Verified backup total exceeds the safe integer range");
    const verifiedAt = requiredDate(artifact.verifiedAt, "Backup verifiedAt");
    if (latestVerifiedAt == null || verifiedAt > latestVerifiedAt) latestVerifiedAt = verifiedAt;
  }

  const totalBytes = imagesBytes + containersBytes + buildCacheBytes;
  if (!Number.isSafeInteger(totalBytes)) throw new Error("Docker total exceeds the safe integer range");
  return {
    schemaVersion: 1,
    measuredAt: requiredDate(measuredAt, "Snapshot measuredAt"),
    docker: { imagesBytes, containersBytes, buildCacheBytes, totalBytes },
    backups: { bytes: backupBytes, count: artifacts.length, latestVerifiedAt },
  };
}

function exactMode(stat) {
  return Number(stat.mode) & 0o7777;
}

function assertDirectory(stat, expectedUid, expectedGid) {
  if (!stat?.isDirectory?.() || stat?.isSymbolicLink?.() || Number(stat.uid) !== expectedUid ||
      Number(stat.gid) !== expectedGid || exactMode(stat) !== 0o755) {
    throw new Error("Host snapshot directory ownership, type, or mode is unsafe");
  }
}

function assertOwnedFile(stat, { expectedUid, expectedGid, mode, label }) {
  if (!stat?.isFile?.() || stat?.isSymbolicLink?.() || Number(stat.nlink) !== 1 ||
      Number(stat.uid) !== expectedUid || Number(stat.gid) !== expectedGid || exactMode(stat) !== mode) {
    throw new Error(`${label} ownership, type, link count, or mode is unsafe`);
  }
}

export async function writeHostStorageSnapshot(snapshot, {
  directory = HOST_STORAGE_SNAPSHOT_DIRECTORY,
  expectedUid = process.getuid(),
  expectedGid = process.getgid(),
  fileStat = lstat,
  openFile = open,
  renameFile = rename,
  unlinkFile = unlink,
} = {}) {
  assertDirectory(await fileStat(directory), expectedUid, expectedGid);
  const finalPath = `${directory}/${HOST_STORAGE_SNAPSHOT_FILENAME}`;
  const temporaryPath = `${directory}/${HOST_STORAGE_SNAPSHOT_TEMP_FILENAME}`;
  try {
    const existingTemporary = await fileStat(temporaryPath);
    assertOwnedFile(existingTemporary, { expectedUid, expectedGid, mode: 0o600, label: "Host snapshot temporary file" });
    await unlinkFile(temporaryPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    const existingFinal = await fileStat(finalPath);
    assertOwnedFile(existingFinal, { expectedUid, expectedGid, mode: 0o644, label: "Host snapshot file" });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const payload = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(payload) > HOST_STORAGE_SNAPSHOT_MAX_BYTES) {
    throw new Error("Host storage snapshot exceeds the fixed size limit");
  }
  const handle = await openFile(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.chmod(0o644);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlinkFile(temporaryPath).catch(() => {});
    throw error;
  }
  await handle.close();
  await renameFile(temporaryPath, finalPath);
  const directoryHandle = await openFile(directory, "r");
  try { await directoryHandle.sync(); }
  finally { await directoryHandle.close(); }
  const published = await fileStat(finalPath);
  assertOwnedFile(published, { expectedUid, expectedGid, mode: 0o644, label: "Published host snapshot" });
  if (safeBytes(published.size, "Published host snapshot size") > HOST_STORAGE_SNAPSHOT_MAX_BYTES) {
    throw new Error("Published host storage snapshot exceeds the fixed size limit");
  }
  return { path: finalPath, bytes: published.size };
}
