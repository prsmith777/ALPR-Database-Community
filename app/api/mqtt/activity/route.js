import {
  mqttAdminErrorMessage,
  mqttAdminErrorStatus,
} from "@/lib/mqtt/admin-api.mjs";
import { getMqttAdminRepository } from "@/lib/mqtt/admin-runtime.mjs";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const repository = await getMqttAdminRepository();
    const activity = await repository.listActivity({
      limit: url.searchParams.get("limit") || 50,
      status: url.searchParams.get("status") || null,
    });
    return Response.json({ success: true, data: activity });
  } catch (error) {
    const status = mqttAdminErrorStatus(error);
    console.error("Error fetching MQTT activity:", error);
    return Response.json(
      {
        success: false,
        error: mqttAdminErrorMessage(error, "Failed to fetch MQTT activity"),
      },
      { status }
    );
  }
}
