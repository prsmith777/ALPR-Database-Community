import { NextResponse } from "next/server";

import { fetchPushoverUsage } from "@/lib/pushover-usage.mjs";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";
import { getConfig } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const denied = await denyUnlessRoutePermission("system.manage_settings");
  if (denied) return denied;

  try {
    const config = await getConfig();
    const usage = await fetchPushoverUsage({
      token: config.notifications?.pushover?.app_token,
      signal: AbortSignal.timeout(8000),
    });

    return NextResponse.json(
      { success: true, data: usage },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const message =
      error?.name === "TimeoutError"
        ? "Pushover did not respond before the usage request timed out"
        : String(error?.message ?? "Unable to load Pushover usage");

    return NextResponse.json(
      { success: false, error: message },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
