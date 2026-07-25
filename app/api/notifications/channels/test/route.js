import { NextResponse } from "next/server";

import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";
import { getConfig } from "@/lib/settings";
import { sendEmailNotification } from "@/lib/email-notifications.mjs";
import { sendWebhookNotification } from "@/lib/webhook-notifications.mjs";

export async function POST(request) {
  const denied = await denyUnlessRoutePermission("notification.manage");
  if (denied) return denied;
  try {
    const body = await request.json();
    const channelType = String(body?.channelType || "").trim().toLowerCase();
    const destination = String(body?.destination || "").trim();
    const config = await getConfig();
    const eventId = `manual-test-${Date.now()}`;
    if (channelType === "email") {
      const result = await sendEmailNotification({
        config: config.notifications?.email || {},
        payload: {
          eventId,
          eventType: "notification.test",
          plateNumber: "TEST123",
          cameraName: "Manual test",
          recipients: destination,
          subject: "ALPR email notification test",
          message: "This is a test email from ALPR Database Community. No plate read triggered this message.",
        },
      });
      return NextResponse.json({ success: true, message: "Test email accepted by the SMTP server", data: result });
    }
    if (channelType === "webhook") {
      const result = await sendWebhookNotification({
        config: config.notifications?.webhook || {},
        payload: {
          eventId,
          idempotencyKey: eventId,
          url: destination,
          body: {
            schema_version: 1,
            event_id: eventId,
            event_type: "notification.test",
            timestamp: new Date().toISOString(),
            message: "This is a test webhook from ALPR Database Community.",
          },
        },
      });
      return NextResponse.json({ success: true, message: "Test webhook delivered", data: result });
    }
    return NextResponse.json({ success: false, error: "Select Email or Webhook" }, { status: 400 });
  } catch (error) {
    console.error("Notification channel test failed", {
      error: String(error?.message || error).slice(0, 1000),
    });
    return NextResponse.json(
      { success: false, error: String(error?.message || "Test delivery failed").slice(0, 1000) },
      { status: 400 }
    );
  }
}
