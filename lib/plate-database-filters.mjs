import { buildFuzzyPlateSql } from "./plate-matching.mjs";

function isHour(value) {
  return Number.isInteger(value) && value >= 0 && value <= 23;
}

function filterList(value, legacyValue) {
  const source = Array.isArray(value)
    ? value
    : legacyValue && legacyValue !== "all"
      ? [legacyValue]
      : [];
  return source.map((item) => String(item).trim()).filter(Boolean);
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

  const tags = filterList(filters.tags, filters.tag);
  if (tags.length > 0) {
    const tagConditions = [];
    if (tags.includes("untagged")) {
      tagConditions.push(`NOT EXISTS (
        SELECT 1 FROM plate_tags pt_filter
        WHERE pt_filter.plate_number = p.plate_number
      )`);
    }
    const namedTags = tags.filter((tag) => tag !== "untagged");
    if (namedTags.length > 0) {
      const tagParameter = addValue(namedTags);
      tagConditions.push(`EXISTS (
        SELECT 1
        FROM plate_tags pt_filter
        JOIN tags t_filter ON pt_filter.tag_id = t_filter.id
        WHERE pt_filter.plate_number = p.plate_number
          AND t_filter.name = ANY(${tagParameter}::text[])
      )`);
    }
    conditions.push(
      tagConditions.length > 1
        ? `(${tagConditions.join(" OR ")})`
        : tagConditions[0]
    );
  }

  const readConditions = ["pr_filter.plate_number = p.plate_number"];
  const cameraNames = filterList(filters.cameraNames, filters.cameraName).map(
    (camera) => camera.toLowerCase()
  );
  if (cameraNames.length > 0) {
    const cameraParameter = addValue(cameraNames);
    readConditions.push(
      `LOWER(pr_filter.camera_name) = ANY(${cameraParameter}::text[])`
    );
  }

  const hasDateFilter = Boolean(
    filters.dateRange?.from || filters.dateRange?.to
  );
  const hourFrom = Number(filters.hourRange?.from);
  const hourTo = Number(filters.hourRange?.to);
  const hasHourFilter = isHour(hourFrom) && isHour(hourTo);
  const timeZoneParameter =
    filters.timeZone && (hasDateFilter || hasHourFilter)
      ? addValue(filters.timeZone)
      : null;
  const timestampExpression = timeZoneParameter
    ? `(pr_filter.timestamp AT TIME ZONE ${timeZoneParameter})`
    : "pr_filter.timestamp";

  if (filters.dateRange?.from) {
    readConditions.push(
      `${timestampExpression}::date >= ${addValue(filters.dateRange.from)}`
    );
  }
  if (filters.dateRange?.to) {
    readConditions.push(
      `${timestampExpression}::date <= ${addValue(filters.dateRange.to)}`
    );
  }

  if (hasHourFilter) {
    const fromParameter = addValue(hourFrom);
    const toParameter = addValue(hourTo);
    const hourExpression = `EXTRACT(HOUR FROM ${timestampExpression})`;
    if (hourFrom <= hourTo) {
      readConditions.push(
        `${hourExpression} BETWEEN ${fromParameter} AND ${toParameter}`
      );
    } else {
      readConditions.push(`(
        ${hourExpression} >= ${fromParameter}
        OR ${hourExpression} <= ${toParameter}
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
