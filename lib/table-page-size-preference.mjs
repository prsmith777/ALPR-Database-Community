const STORAGE_PREFIX = "alpr.table.pageSize";
const SURFACES = new Set(["live-feed", "plate-database"]);
const ALLOWED_PAGE_SIZES = new Set([10, 25, 50, 100, 250, 500]);

export function normalizeTablePageSize(value, fallback = 25) {
  const normalizedFallback = ALLOWED_PAGE_SIZES.has(Number(fallback))
    ? Number(fallback)
    : 25;
  const numericValue = Number(value);
  return ALLOWED_PAGE_SIZES.has(numericValue)
    ? numericValue
    : normalizedFallback;
}

export function tablePageSizePreferenceKey(surface) {
  if (!SURFACES.has(surface)) {
    throw new Error(`Unsupported table page-size preference surface: ${surface}`);
  }
  return `${STORAGE_PREFIX}.${surface}`;
}

export function readTablePageSizePreference(
  surface,
  fallback = 25,
  storage = globalThis?.localStorage
) {
  const normalizedFallback = normalizeTablePageSize(fallback);
  try {
    return normalizeTablePageSize(
      storage?.getItem(tablePageSizePreferenceKey(surface)),
      normalizedFallback
    );
  } catch {
    return normalizedFallback;
  }
}

export function writeTablePageSizePreference(
  surface,
  pageSize,
  storage = globalThis?.localStorage
) {
  const normalizedPageSize = normalizeTablePageSize(pageSize);
  try {
    storage?.setItem(
      tablePageSizePreferenceKey(surface),
      String(normalizedPageSize)
    );
  } catch {
    // Browsers can block storage; the current selection still remains usable.
  }
  return normalizedPageSize;
}
