import { getMqttAdminRepository } from "@/lib/mqtt/admin-runtime.mjs";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

export async function GET() {
  const denied = await denyUnlessRoutePermission("mqtt.manage");
  if (denied) return denied;
  try {
    const repository = await getMqttAdminRepository();
    const cameras = await repository.listCameras();
    return Response.json({ success: true, data: cameras });
  } catch (error) {
    console.error("Error fetching MQTT cameras:", error);
    return Response.json(
      { success: false, error: "Failed to fetch MQTT cameras" },
      { status: 500 }
    );
  }
}
