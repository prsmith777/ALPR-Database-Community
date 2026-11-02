import mqtt from "mqtt";
import { getPool } from "@/lib/db";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";
import { CameraInputRepository } from "@/lib/camera-inputs/repository.mjs";
import { testMqttConnection } from "@/lib/camera-inputs/connection-test.mjs";

export async function POST(_request, { params }) {
  const denied = await denyUnlessRoutePermission("system.manage_settings");
  if (denied) return denied;
  const { id } = await params;
  try {
    const input = (
      await new CameraInputRepository(await getPool()).mqttInputs()
    ).find((row) => row.id === id);
    if (!input?.broker_enabled)
      return Response.json(
        { error: "Select an enabled MQTT input and broker first" },
        { status: 400 },
      );
    return Response.json(await testMqttConnection(input, mqtt.connect), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Connection test unavailable" },
      { status: 503 },
    );
  }
}
