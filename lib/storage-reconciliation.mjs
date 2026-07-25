import path from "node:path";

export const STORAGE_RECONCILIATION_JOB = "storage-reconciliation";
export const STORAGE_RECONCILIATION_ROOTS = Object.freeze([
  "images",
  "thumbnails",
  "derived",
]);

function finiteCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function normalizeStorageRelativePath(value) {
  const normalized = String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/").filter(Boolean);
  if (
    !segments.length ||
    !STORAGE_RECONCILIATION_ROOTS.includes(segments[0]) ||
    segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))
  ) {
    throw new Error("Invalid reconciliation storage path");
  }
  return segments.join("/");
}

export function joinStorageRelativePath(parent, name) {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error("Invalid reconciliation directory entry");
  }
  return normalizeStorageRelativePath(path.posix.join(parent, name));
}

export function selectDirectoryEntries(entries = [], { cursor = null, limit = 250 } = {}) {
  const boundedLimit = Math.min(1_000, Math.max(1, Number.parseInt(String(limit), 10) || 250));
  const selected = [...entries]
    .filter((entry) => entry?.name && (!cursor || entry.name > cursor))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .slice(0, boundedLimit);
  return {
    entries: selected,
    nextCursor: selected.at(-1)?.name || cursor || null,
    complete: selected.length < boundedLimit,
  };
}

export async function inspectFilesystemEntries({
  parent,
  entries = [],
  scanStartedAt,
  statPath,
  referencedPaths = new Set(),
} = {}) {
  const directories = [];
  const orphanFiles = [];
  const inspectedFiles = [];
  let recentFilesSkipped = 0;
  let skippedEntries = 0;
  let errorCount = 0;
  const cutoff = new Date(scanStartedAt).getTime();

  for (const entry of entries) {
    let relativePath;
    try {
      relativePath = joinStorageRelativePath(parent, entry.name);
    } catch {
      errorCount += 1;
      continue;
    }
    if (entry.isSymbolicLink?.()) {
      skippedEntries += 1;
      continue;
    }
    if (entry.isDirectory?.()) {
      directories.push(relativePath);
      continue;
    }
    if (!entry.isFile?.()) {
      skippedEntries += 1;
      continue;
    }
    try {
      const stats = await statPath(relativePath);
      if (!stats?.isFile?.() || stats?.isSymbolicLink?.()) {
        skippedEntries += 1;
        continue;
      }
      const file = {
        relativePath,
        sizeBytes: finiteCount(stats.size),
        modifiedAt: new Date(stats.mtime).toISOString(),
      };
      inspectedFiles.push(file);
      if (new Date(stats.mtime).getTime() > cutoff) {
        recentFilesSkipped += 1;
      } else if (!referencedPaths.has(relativePath)) {
        orphanFiles.push(file);
      }
    } catch {
      errorCount += 1;
    }
  }

  return {
    directories,
    inspectedFiles,
    orphanFiles,
    recentFilesSkipped,
    skippedEntries,
    errorCount,
  };
}

export async function inspectDatabaseReferences({ references = [], statPath } = {}) {
  const missing = [];
  let checked = 0;
  let errorCount = 0;
  const unique = new Map();
  for (const reference of references) {
    if (!reference?.relativePath) continue;
    try {
      const relativePath = normalizeStorageRelativePath(reference.relativePath);
      if (!unique.has(relativePath)) unique.set(relativePath, { ...reference, relativePath });
    } catch {
      errorCount += 1;
    }
  }

  for (const reference of unique.values()) {
    checked += 1;
    try {
      const stats = await statPath(reference.relativePath);
      if (!stats?.isFile?.() || stats?.isSymbolicLink?.()) errorCount += 1;
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) missing.push(reference);
      else errorCount += 1;
    }
  }
  return { checked, missing, errorCount };
}

export function buildReconciliationResult(row = {}) {
  return {
    mode: "read-only",
    destructive: false,
    runId: finiteCount(row.id) || null,
    scanStartedAt: row.scan_started_at || null,
    completedAt: row.completed_at || null,
    filesScanned: finiteCount(row.files_scanned),
    bytesScanned: finiteCount(row.bytes_scanned),
    referencesChecked: finiteCount(row.references_checked),
    recentFilesSkipped: finiteCount(row.recent_files_skipped),
    skippedEntries: finiteCount(row.skipped_entries),
    errorCount: finiteCount(row.error_count),
    orphanFiles: finiteCount(row.orphan_files),
    orphanBytes: finiteCount(row.orphan_bytes),
    missingReferencePaths: finiteCount(row.missing_reference_paths),
    note: "Inventory only; no file or application record was modified or deleted.",
  };
}
