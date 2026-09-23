const TEXT_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function normalizeSortValue(plate, key) {
  if (key === "created_at") {
    const timestamp = Date.parse(plate?.created_at);
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  if (key === "tags") {
    const tags = Array.isArray(plate?.tags) ? plate.tags : [];
    return tags
      .map((tag) => (typeof tag === "string" ? tag : tag?.name))
      .filter(Boolean)
      .sort((left, right) => TEXT_COLLATOR.compare(left, right))
      .join(", ");
  }

  const value = plate?.[key];
  return value == null ? null : String(value).trim();
}

function compareValues(left, right, direction) {
  const leftMissing = left == null || left === "";
  const rightMissing = right == null || right === "";

  // Empty optional values remain at the bottom in either direction.
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return 0;
    return leftMissing ? 1 : -1;
  }

  const comparison =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : TEXT_COLLATOR.compare(String(left), String(right));

  return direction === "desc" ? -comparison : comparison;
}

export function sortKnownPlates(
  plates,
  { key = "created_at", direction = "desc" } = {}
) {
  if (!Array.isArray(plates)) return [];

  return plates
    .map((plate, index) => ({ plate, index }))
    .sort((left, right) => {
      const valueComparison = compareValues(
        normalizeSortValue(left.plate, key),
        normalizeSortValue(right.plate, key),
        direction
      );

      if (valueComparison !== 0) return valueComparison;
      return left.index - right.index;
    })
    .map(({ plate }) => plate);
}
