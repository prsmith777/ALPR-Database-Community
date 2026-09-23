import { NextResponse } from "next/server";

import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

async function retired() {
  const denied = await denyUnlessRoutePermission("mqtt.manage");
  if (denied) return denied;
  return NextResponse.json(
    { error: "Legacy MQTT rule management has been retired. Manage MQTT actions on Notifications." },
    { status: 410 }
  );
}

export const GET = retired;
export const POST = retired;
