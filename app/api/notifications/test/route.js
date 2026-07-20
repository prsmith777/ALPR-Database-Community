import { sendPushoverNotification } from "@/lib/notifications";
import { NextResponse } from "next/server";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

export async function POST(request) {
  const denied = await denyUnlessRoutePermission("notification.manage");
  if (denied) return denied;
  try {
    const formData = await request.formData();
    const plateNumber = formData.get("plateNumber");

    if (!plateNumber) {
      return NextResponse.json(
        { success: false, error: "Plate number is required" },
        { status: 400 }
      );
    }

    // Create a test message that makes it clear this is a test
    const testMessage = `🔔 TEST NOTIFICATION:\nPlate number ${plateNumber} detected\n\nThis is a test notification sent from the ALPR Database settings panel.`;

    const result = await sendPushoverNotification(plateNumber, testMessage);

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: "Test notification sent successfully",
        data: result.data,
      });
    } else {
      // If there's a specific error from Pushover, pass it through
      return NextResponse.json(
        {
          success: false,
          error: result.error || "Failed to send test notification",
          details: result.data,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Test notification error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to send test notification",
        details: error.message,
      },
      { status: 500 }
    );
  }
}
