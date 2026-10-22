const TABLE_COLUMNS = {
  "live-feed": [
    { id: "image", label: "Image", width: 104, min: 72 },
    { id: "plate_number", label: "Plate Number", width: 148, min: 104 },
    { id: "state_country", label: "State/Country", width: 176, min: 104 },
    { id: "confidence", label: "Confidence", width: 72, min: 56 },
    { id: "occurrence_count", label: "Count", width: 80, min: 64 },
    { id: "tags", label: "Tags", width: 160, min: 88 },
    { id: "camera_name", label: "Camera", width: 152, min: 88 },
    { id: "direction", label: "Direction", width: 128, min: 88 },
    { id: "timestamp", label: "Timestamp", width: 176, min: 104 },
    { id: "actions", label: "Actions", width: 80, min: 56 },
  ],
  "plate-database": [
    { id: "plate_number", label: "Plate Number", width: 160, min: 104 },
    { id: "occurrence_count", label: "Seen", width: 80, min: 64 },
    { id: "state_country", label: "State/Country", width: 176, min: 104 },
    { id: "name", label: "Name", width: 200, min: 88 },
    { id: "notes", label: "Notes", width: 260, min: 104 },
    { id: "first_seen_at", label: "First Seen", width: 144, min: 104 },
    { id: "last_seen_at", label: "Last Seen", width: 176, min: 104 },
    { id: "tags", label: "Tags", width: 160, min: 88 },
    { id: "actions", label: "Actions", width: 80, min: 56 },
  ],
};

export function tableColumns(surface, showStateCountry = true) {
  const columns = TABLE_COLUMNS[surface];
  if (!columns) throw new Error(`Unsupported table: ${surface}`);
  return columns.filter((column) => showStateCountry || column.id !== "state_country");
}

export function clampColumnWidth(column, value) {
  return Math.round(Math.min(1000, Math.max(column.min, Number.isFinite(value) ? value : column.width)));
}

export function columnWidthForKey(column, width, key, shift = false) {
  if (key === "Home") return column.min;
  if (key === "End") return 1000;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  return clampColumnWidth(column, width + (key === "ArrowRight" ? 1 : -1) * (shift ? 50 : 10));
}

export function normalizeColumnWidths(surface, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const widths = {};
  for (const column of tableColumns(surface)) {
    if (typeof value[column.id] === "number" && Number.isFinite(value[column.id])) {
      widths[column.id] = clampColumnWidth(column, value[column.id]);
    }
  }
  return Object.keys(widths).length ? widths : null;
}

function preferenceKey(surface) {
  tableColumns(surface);
  return `alpr.table.columnWidths.v1.${surface}`;
}

export function readColumnWidths(surface, storage) {
  try {
    return normalizeColumnWidths(surface, JSON.parse((storage ?? globalThis.localStorage)?.getItem(preferenceKey(surface)) ?? "null"));
  } catch {
    return null;
  }
}

export function writeColumnWidths(surface, value, storage) {
  const widths = normalizeColumnWidths(surface, value);
  try {
    const target = storage ?? globalThis.localStorage;
    if (widths) target?.setItem(preferenceKey(surface), JSON.stringify(widths));
    else target?.removeItem(preferenceKey(surface));
  } catch {
    // Resizing still works for this visit when browser storage is blocked.
  }
  return widths;
}
