const PLATE_DATABASE_SORTS = Object.freeze({
  plate_number: Object.freeze({
    inner: "p.plate_number",
    outer: "pd.plate_number",
  }),
  occurrence_count: Object.freeze({
    inner: "COUNT(pr.id)",
    outer: "pd.occurrence_count",
  }),
  first_seen_at: Object.freeze({
    inner: "p.first_seen_at",
    outer: "pd.first_seen_at",
  }),
  last_seen_at: Object.freeze({
    inner: "MAX(pr.timestamp)",
    outer: "pd.last_seen_at",
  }),
});

const DEFAULT_PLATE_DATABASE_SORT = PLATE_DATABASE_SORTS.first_seen_at;

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

  if (sort.field === "occurrence_count") {
    return `ORDER BY p.occurrence_count ${direction}, pr.timestamp DESC`;
  }

  if (sort.field === "timestamp" && direction === "ASC") {
    return "ORDER BY pr.timestamp ASC";
  }

  return "ORDER BY pr.timestamp DESC";
}
