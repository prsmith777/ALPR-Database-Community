import { getMqttAdminRepository } from "@/lib/mqtt/admin-runtime.mjs";

export async function GET() {
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
