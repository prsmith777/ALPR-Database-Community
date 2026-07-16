import path from "path";

const DEFAULT_ALLOWED_ROOTS = ["images", "thumbnails"];

export function sanitizeStorageComponent(value, fallback = "unknown") {
  const sanitized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

  return sanitized || fallback;
}

export function isPathInside(basePath, candidatePath) {
  const relative = path.relative(path.resolve(basePath), path.resolve(candidatePath));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function resolveStoragePath(
  baseDir,
  relativePath,
  allowedRoots = DEFAULT_ALLOWED_ROOTS
) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("Invalid storage path");
  }

  if (
    relativePath.includes("\0") ||
    path.isAbsolute(relativePath) ||
    /^[A-Za-z]:[\\/]/.test(relativePath) ||
    /^[\\/]{2}/.test(relativePath) ||
    relativePath.split(/[\\/]+/).some((segment) => segment === "..")
  ) {
    throw new Error("Invalid storage path");
  }

  const normalizedPath = path.normalize(relativePath);
  const fullPath = path.resolve(baseDir, normalizedPath);

  if (!isPathInside(baseDir, fullPath)) {
    throw new Error("Invalid storage path");
  }

  const relativeToBase = path.relative(path.resolve(baseDir), fullPath);
  const root = relativeToBase.split(path.sep)[0];

  if (!allowedRoots.includes(root)) {
    throw new Error("Invalid storage root");
  }

  return fullPath;
}
