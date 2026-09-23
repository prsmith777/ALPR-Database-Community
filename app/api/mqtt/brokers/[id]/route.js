import {
  mqttAdminErrorMessage,
  mqttAdminErrorStatus,
  readJsonObject,
} from "@/lib/mqtt/admin-api.mjs";
import { getMqttAdminRepository } from "@/lib/mqtt/admin-runtime.mjs";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

async function getBrokerId(params) {
  const resolved = await params;
  return resolved.id;
}

export async function GET(_request, { params }) {
  const denied = await denyUnlessRoutePermission("mqtt.manage");
  if (denied) return denied;
  try {
    const repository = await getMqttAdminRepository();
    const broker = await repository.getBroker(await getBrokerId(params));

    if (!broker) {
      return Response.json(
        { success: false, error: "Broker not found" },
        { status: 404 }
      );
    }

    return Response.json({ success: true, data: broker });
  } catch (error) {
    const status = mqttAdminErrorStatus(error);
    console.error("Error fetching MQTT broker:", error);
    return Response.json(
      {
        success: false,
        error: mqttAdminErrorMessage(error, "Failed to fetch MQTT broker"),
      },
      { status }
    );
  }
}

export async function PUT(request, { params }) {
  const denied = await denyUnlessRoutePermission("mqtt.manage");
  if (denied) return denied;
  try {
    const data = await readJsonObject(request);

    // The edit form intentionally displays no stored password. Submitting that
    // blank field preserves the current credential; clearPassword explicitly
    // removes it.
    if (data.password === "") delete data.password;

    const repository = await getMqttAdminRepository();
    const broker = await repository.updateBroker(
      await getBrokerId(params),
      data
    );

    if (!broker) {
      return Response.json(
        { success: false, error: "Broker not found" },
        { status: 404 }
      );
    }

    return Response.json({ success: true, data: broker });
  } catch (error) {
    const status = mqttAdminErrorStatus(error);
    console.error("Error updating MQTT broker:", error);
    return Response.json(
      {
        success: false,
        error: mqttAdminErrorMessage(error, "Failed to update MQTT broker"),
      },
      { status }
    );
  }
}

export async function DELETE(_request, { params }) {
  const denied = await denyUnlessRoutePermission("mqtt.manage");
  if (denied) return denied;
  try {
    const repository = await getMqttAdminRepository();
    const deleted = await repository.deleteBroker(await getBrokerId(params));

    if (!deleted) {
      return Response.json(
        { success: false, error: "Broker not found" },
        { status: 404 }
      );
    }

    return Response.json({ success: true });
  } catch (error) {
    const status = mqttAdminErrorStatus(error);
    console.error("Error deleting MQTT broker:", error);
    return Response.json(
      {
        success: false,
        error: mqttAdminErrorMessage(
          error,
          status === 409
            ? "Broker is still used by an MQTT rule or delivery"
            : "Failed to delete MQTT broker"
        ),
      },
      { status }
    );
  }
}
