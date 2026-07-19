import { getPlateDatabaseExport } from "@/lib/db";
import {
  serializePlateExportCsv,
  serializePlateExportJson,
} from "@/lib/plate-export.mjs";
import { getConfig } from "@/lib/settings";

export const dynamic = "force-dynamic";

function parseHour(value) {
  if (value === null || value === "") return undefined;
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23
    ? hour
    : undefined;
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const format = (url.searchParams.get("format") || "csv").toLowerCase();
    if (!new Set(["csv", "json"]).has(format)) {
      return Response.json(
        { success: false, error: "Export format must be CSV or JSON." },
        { status: 400 }
      );
    }

    const hourFrom = parseHour(url.searchParams.get("hourFrom"));
    const hourTo = parseHour(url.searchParams.get("hourTo"));
    const config = await getConfig();
    const legacyFuzzy = url.searchParams.get("fuzzySearch") === "true";
    const result = await getPlateDatabaseExport({
      filters: {
        search: url.searchParams.get("search") || "",
        matchMode:
          url.searchParams.get("matchMode") ||
          (legacyFuzzy ? "balanced" : "default"),
        matchingSettings: config.plateMatching,
        tag: url.searchParams.get("tag") || "all",
        cameraName: url.searchParams.get("camera") || "",
        dateRange: {
          from: url.searchParams.get("dateFrom") || null,
          to: url.searchParams.get("dateTo") || null,
        },
        hourRange:
          hourFrom !== undefined && hourTo !== undefined
            ? { from: hourFrom, to: hourTo }
            : null,
      },
      sortBy: url.searchParams.get("sortField") || "last_seen_at",
      sortDesc: url.searchParams.get("sortDirection") !== "asc",
    });

    const exportedAt = new Date();
    const dateStamp = exportedAt.toISOString().slice(0, 10);
    const body =
      format === "csv"
        ? serializePlateExportCsv(result.data)
        : serializePlateExportJson(result, exportedAt);

    return new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="alpr-plates-${dateStamp}.${format}"`,
        "Content-Type":
          format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/json; charset=utf-8",
        "X-Exported-Count": String(result.data.length),
        "X-Export-Truncated": String(result.truncated),
      },
    });
  } catch (error) {
    console.error("Plate database export failed:", error);
    return Response.json(
      { success: false, error: "Unable to export the plate database." },
      { status: 500 }
    );
  }
}
