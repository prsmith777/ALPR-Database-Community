import {
  mqttAdminErrorMessage,
  mqttAdminErrorStatus,
  readJsonObject,
} from "@/lib/mqtt/admin-api.mjs";
import { getMqttAdminRepository } from "@/lib/mqtt/admin-runtime.mjs";

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const data = await readJsonObject(request);
    const repository = await getMqttAdminRepository();
    const camera = await repository.updateCamera(id, data);

    if (!camera) {
      return Response.json(
        { success: false, error: "Camera not found" },
        { status: 404 }
      );
    }

    return Response.json({ success: true, data: camera });
  } catch (error) {
    const status = mqttAdminErrorStatus(error);
    console.error("Error updating MQTT camera:", error);
    return Response.json(
      {
        success: false,
        error: mqttAdminErrorMessage(error, "Failed to update MQTT camera"),
      },
      { status }
    );
  }
}
