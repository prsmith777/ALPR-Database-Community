const PLATE_DATABASE_SORTS = Object.freeze({
  plate_number: Object.freeze({
    inner: "p.plate_number",
    outer: "pd.plate_number",
  }),
  occurrence_count: Object.freeze({
    inner: "COUNT(pr.id)",
    outer: "pd.occurrence_count",
  }),
  name: Object.freeze({
    inner: "LOWER(kp.name)",
    outer: "LOWER(pd.name)",
  }),
  notes: Object.freeze({
    inner: "LOWER(kp.notes)",
    outer: "LOWER(pd.notes)",
  }),
  first_seen_at: Object.freeze({
    inner: "p.first_seen_at",
    outer: "pd.first_seen_at",
  }),
  last_seen_at: Object.freeze({
    inner: "MAX(pr.timestamp)",
    outer: "pd.last_seen_at",
  }),
  tags: Object.freeze({
    inner: "tags_sort_key",
    outer: "pd.tags_sort_key",
  }),
});

const DEFAULT_PLATE_DATABASE_SORT = PLATE_DATABASE_SORTS.first_seen_at;

const PLATE_READ_SORTS = Object.freeze({
  plate_number: "LOWER(pr.plate_number)",
  confidence: "pr.confidence",
  occurrence_count: "p.occurrence_count",
  camera_name: "LOWER(pr.camera_name)",
  timestamp: "pr.timestamp",
});

const DEFAULT_PLATE_READ_SORT = PLATE_READ_SORTS.timestamp;

export function getPlateDatabaseOrderBy(sortBy, sortDesc = true) {
  const selectedSort = Object.prototype.hasOwnProperty.call(
    PLATE_DATABASE_SORTS,
    sortBy
  )
    ? PLATE_DATABASE_SORTS[sortBy]
    : DEFAULT_PLATE_DATABASE_SORT;

  const direction =
    sortDesc === false ? "ASC NULLS LAST" : "DESC NULLS LAST";

  return {
    innerOrderBy: `ORDER BY ${selectedSort.inner} ${direction}`,
    outerOrderBy: `ORDER BY ${selectedSort.outer} ${direction}`,
  };
}

export function getPlateReadsOrderBy(sort = {}) {
  const direction = sort.direction === "asc" ? "ASC" : "DESC";
  const isAllowed = Object.prototype.hasOwnProperty.call(
    PLATE_READ_SORTS,
    sort.field
  );
  const selected = isAllowed
    ? PLATE_READ_SORTS[sort.field]
    : DEFAULT_PLATE_READ_SORT;
  const selectedDirection = isAllowed ? direction : "DESC";
  const tieBreakers =
    selected === PLATE_READ_SORTS.timestamp
      ? "pr.id DESC"
      : "pr.timestamp DESC, pr.id DESC";

  return `ORDER BY ${selected} ${selectedDirection} NULLS LAST, ${tieBreakers}`;
}
