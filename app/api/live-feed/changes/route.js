import { getPlateReads } from "@/lib/db";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function readIdsFrom(request) {
  const values = new URL(request.url).searchParams.getAll("readId");
  return [...new Set(values
    .flatMap((value) => value.split(","))
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0))]
    .slice(0, 25);
}

function duration(startedAt) {
  return Math.max(0, performance.now() - startedAt).toFixed(1);
}

export async function GET(request) {
  const requestStartedAt = performance.now();
  const authStartedAt = performance.now();
  const denied = await denyUnlessRoutePermission("plate.read");
  const authDuration = duration(authStartedAt);
  if (denied) return denied;

  const readIds = readIdsFrom(request);
  if (readIds.length === 0) {
    return Response.json(
      { success: false, error: "At least one readId is required." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const queryStartedAt = performance.now();
  const result = await getPlateReads({
    page: 1,
    pageSize: readIds.length,
    filters: { readIds },
  });
  const queryDuration = duration(queryStartedAt);
  const totalDuration = duration(requestStartedAt);

  return Response.json(
    { success: true, data: result.data, readIds },
    {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Server-Timing": `auth;dur=${authDuration}, db;dur=${queryDuration}, total;dur=${totalDuration}`,
      },
    }
  );
}
