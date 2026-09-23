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
    const brokers = await repository.listBrokers();
    return Response.json({ success: true, data: brokers });
  } catch (error) {
    console.error("Error fetching MQTT brokers:", error);
    return Response.json(
      { success: false, error: "Failed to fetch MQTT brokers" },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  const denied = await denyUnlessRoutePermission("mqtt.manage");
  if (denied) return denied;
  try {
    const data = await readJsonObject(request);
    const repository = await getMqttAdminRepository();
    const broker = await repository.createBroker(data);
    return Response.json({ success: true, data: broker }, { status: 201 });
  } catch (error) {
    const status = mqttAdminErrorStatus(error);
    console.error("Error adding MQTT broker:", error);
    return Response.json(
      {
        success: false,
        error: mqttAdminErrorMessage(error, "Failed to add MQTT broker"),
      },
      { status }
    );
  }
}
