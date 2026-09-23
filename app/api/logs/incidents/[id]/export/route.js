import { getPool } from "@/lib/db";
import { getLoggingIncidentExport } from "@/lib/logging-retention.mjs";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const denied = await denyUnlessRoutePermission("system.view_audit");
  if (denied) return denied;
  try {
    const { id } = await params;
    const pool = await getPool();
    const evidence = await getLoggingIncidentExport(
      (text, values) => pool.query(text, values),
      id,
    );
    if (!evidence) {
      return Response.json(
        { success: false, error: "Incident evidence was not found." },
        { status: 404 },
      );
    }
    const body = JSON.stringify({
      exportedAt: new Date().toISOString(),
      ...evidence,
    }, null, 2);
    return new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="alpr-incident-${evidence.incident.id}.json"`,
        "Content-Type": "application/json; charset=utf-8",
        "X-Incident-Snapshot-SHA256": evidence.incident.snapshotSha256,
      },
    });
  } catch {
    return Response.json(
      { success: false, error: "Unable to export incident evidence." },
      { status: 500 },
    );
  }
}
