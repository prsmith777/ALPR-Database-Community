import { buildFuzzyPlateSql } from "./plate-matching.mjs";

function isHour(value) {
  return Number.isInteger(value) && value >= 0 && value <= 23;
}

export function buildPlateDatabaseFilterClause(filters = {}) {
  const conditions = [];
  const values = [];

  const addValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  const search = String(filters.search || "").trim();
  if (search) {
    const containsParameter = addValue(`%${search}%`);
    const textConditions = [
      `p.plate_number ILIKE ${containsParameter}`,
      `kp.name ILIKE ${containsParameter}`,
      `kp.notes ILIKE ${containsParameter}`,
    ];
    const { condition: fuzzyCondition } = buildFuzzyPlateSql({
      columnExpression: "p.plate_number",
      searchValue: search,
      requestedMode:
        filters.matchMode || "balanced",
      settings: filters.matchingSettings,
      addValue,
    });
    if (fuzzyCondition) textConditions.push(fuzzyCondition);

    conditions.push(`(${textConditions.join(" OR ")})`);
  }

  const tag = String(filters.tag || "").trim();
  if (tag && tag !== "all") {
    if (tag === "untagged") {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM plate_tags pt_filter
        WHERE pt_filter.plate_number = p.plate_number
      )`);
    } else {
      const tagParameter = addValue(tag);
      conditions.push(`EXISTS (
        SELECT 1
        FROM plate_tags pt_filter
        JOIN tags t_filter ON pt_filter.tag_id = t_filter.id
        WHERE pt_filter.plate_number = p.plate_number
          AND t_filter.name = ${tagParameter}
      )`);
    }
  }

  const readConditions = ["pr_filter.plate_number = p.plate_number"];
  const cameraName = String(filters.cameraName || "").trim();
  if (cameraName) {
    const cameraParameter = addValue(cameraName);
    readConditions.push(
      `LOWER(pr_filter.camera_name) = LOWER(${cameraParameter})`
    );
  }

  if (filters.dateRange?.from) {
    readConditions.push(
      `pr_filter.timestamp::date >= ${addValue(filters.dateRange.from)}`
    );
  }
  if (filters.dateRange?.to) {
    readConditions.push(
      `pr_filter.timestamp::date <= ${addValue(filters.dateRange.to)}`
    );
  }

  const hourFrom = Number(filters.hourRange?.from);
  const hourTo = Number(filters.hourRange?.to);
  if (isHour(hourFrom) && isHour(hourTo)) {
    const fromParameter = addValue(hourFrom);
    const toParameter = addValue(hourTo);
    if (hourFrom <= hourTo) {
      readConditions.push(
        `EXTRACT(HOUR FROM pr_filter.timestamp) BETWEEN ${fromParameter} AND ${toParameter}`
      );
    } else {
      readConditions.push(`(
        EXTRACT(HOUR FROM pr_filter.timestamp) >= ${fromParameter}
        OR EXTRACT(HOUR FROM pr_filter.timestamp) <= ${toParameter}
      )`);
    }
  }

  if (readConditions.length > 1) {
    conditions.push(`EXISTS (
      SELECT 1 FROM plate_reads pr_filter
      WHERE ${readConditions.join(" AND ")}
    )`);
  }

  return {
    whereClause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}
