import {
  mqttAdminErrorMessage,
  mqttAdminErrorStatus,
  readJsonObject,
} from "@/lib/mqtt/admin-api.mjs";
import {
  getMqttAdminRepository,
} from "@/lib/mqtt/admin-runtime.mjs";
import { startMqttRuntime } from "@/lib/mqtt/runtime.mjs";
import { queueMqttTestPublish } from "@/lib/mqtt/test-publish.mjs";

export async function POST(request) {
  try {
    const input = await readJsonObject(request);
    const adminRepository = await getMqttAdminRepository();
    const broker = await adminRepository.getBroker(
      input.brokerId ?? input.broker_id
    );
    const settings = await adminRepository.getSettings();
    const runtime = await startMqttRuntime();

    const result = await queueMqttTestPublish({
      repository: runtime.repository,
      broker,
      settings,
      input,
    });

    return Response.json(
      { success: true, data: result },
      { status: 202 }
    );
  } catch (error) {
    const status = mqttAdminErrorStatus(error);
    console.error("Error queueing MQTT test publish:", error);
    return Response.json(
      {
        success: false,
        error: mqttAdminErrorMessage(
          error,
          "Failed to queue MQTT test publish"
        ),
      },
      { status }
    );
  }
}
