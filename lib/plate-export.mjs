export const PLATE_EXPORT_COLUMNS = Object.freeze([
  "plate_number",
  "known_name",
  "notes",
  "tags",
  "first_seen_at",
  "last_seen_at",
  "occurrence_count",
  "flagged",
]);

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return "";
  return tags
    .map((tag) => (typeof tag === "string" ? tag : tag?.name))
    .filter(Boolean)
    .join("; ");
}

export function normalizePlateExportRow(row) {
  return {
    plate_number: row.plate_number || "",
    known_name: row.name || "",
    notes: row.notes || "",
    tags: normalizeTags(row.tags),
    first_seen_at: row.first_seen_at || null,
    last_seen_at: row.last_seen_at || null,
    occurrence_count: Number(row.occurrence_count || 0),
    flagged: Boolean(row.flagged),
  };
}

function csvValue(value) {
  const rawText = value === null || value === undefined ? "" : String(value);
  // Prevent spreadsheet applications from treating exported user data as a formula.
  const text = /^[=+\-@]/.test(rawText) ? `'${rawText}` : rawText;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializePlateExportCsv(rows) {
  const normalizedRows = rows.map(normalizePlateExportRow);
  return [
    PLATE_EXPORT_COLUMNS.join(","),
    ...normalizedRows.map((row) =>
      PLATE_EXPORT_COLUMNS.map((column) => csvValue(row[column])).join(",")
    ),
  ].join("\r\n");
}

export function serializePlateExportJson(result, exportedAt = new Date()) {
  return JSON.stringify(
    {
      exported_at: exportedAt.toISOString(),
      total_matching: result.total,
      exported_count: result.data.length,
      truncated: result.truncated,
      export_limit: result.limit,
      plates: result.data.map(normalizePlateExportRow),
    },
    null,
    2
  );
}
