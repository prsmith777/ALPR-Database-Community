import {
  mqttAdminErrorMessage,
  mqttAdminErrorStatus,
  readJsonObject,
} from "@/lib/mqtt/admin-api.mjs";
import { getMqttAdminRepository } from "@/lib/mqtt/admin-runtime.mjs";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

export async function GET() {
  const denied = await denyUnlessRoutePermission("mqtt.manage");
  if (denied) return denied;
  try {
    const repository = await getMqttAdminRepository();
    const settings = await repository.getSettings();
    return Response.json({ success: true, data: settings });
  } catch (error) {
    console.error("Error fetching MQTT settings:", error);
    return Response.json(
      { success: false, error: "Failed to fetch MQTT settings" },
      { status: 500 }
    );
  }
}

export async function PUT(request) {
  const denied = await denyUnlessRoutePermission("mqtt.manage");
  if (denied) return denied;
  try {
    const data = await readJsonObject(request);
    const repository = await getMqttAdminRepository();
    const settings = await repository.updateSettings(data);
    return Response.json({ success: true, data: settings });
  } catch (error) {
    const status = mqttAdminErrorStatus(error);
    console.error("Error updating MQTT settings:", error);
    return Response.json(
      {
        success: false,
        error: mqttAdminErrorMessage(error, "Failed to update MQTT settings"),
      },
      { status }
    );
  }
}
