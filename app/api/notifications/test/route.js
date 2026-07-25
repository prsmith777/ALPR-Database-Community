import { NextResponse } from "next/server";

import { sendPushoverNotification } from "@/lib/notifications";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

// Compatibility endpoint for older clients. The current Notifications page
// uses /api/notifications/channels/test for all channel tests.
export async function POST(request) {
  const denied = await denyUnlessRoutePermission("notification.manage");
  if (denied) return denied;
  try {
    const formData = await request.formData();
    const plateNumber = String(formData.get("plateNumber") || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "")
      .slice(0, 16);
    if (!plateNumber) {
      return NextResponse.json({ success: false, error: "Plate number is required" }, { status: 400 });
    }
    const result = await sendPushoverNotification(
      plateNumber,
      `This is a test Pushover notification from ALPR Database Community for sample plate ${plateNumber}. No plate read triggered this message.`
    );
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error || "Pushover test delivery failed" }, { status: 400 });
    }
    return NextResponse.json({ success: true, message: "Test Pushover notification delivered", data: result.data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error?.message || "Pushover test delivery failed").slice(0, 1000) },
      { status: 400 }
    );
  }
}
