const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE = 1_000_000;
const MAX_PAGE_SIZE = 500;

function normalizeInteger(value, fallback, maximum) {
  const numericValue = Number(value);
  if (!Number.isSafeInteger(numericValue) || numericValue < 1) return fallback;
  return Math.min(numericValue, maximum);
}

export function normalizePagination(page, pageSize) {
  return {
    page: normalizeInteger(page, DEFAULT_PAGE, MAX_PAGE),
    pageSize: normalizeInteger(
      pageSize,
      DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE
    ),
  };
}
