import {
  mqttAdminErrorMessage,
  mqttAdminErrorStatus,
  readJsonObject,
} from "@/lib/mqtt/admin-api.mjs";
import { getMqttRuleAdminRepository } from "@/lib/mqtt/admin-runtime.mjs";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

async function getRuleId(params) {
  const resolved = await params;
  return resolved.id;
}

export async function GET(_request, { params }) {
  const denied = await denyUnlessRoutePermission("mqtt.manage");
  if (denied) return denied;
  try {
    const repository = await getMqttRuleAdminRepository();
    const rule = await repository.getRule(await getRuleId(params));

    if (!rule) {
      return Response.json(
        { success: false, error: "Rule not found" },
        { status: 404 }
      );
    }

    return Response.json({ success: true, data: rule });
  } catch (error) {
    const status = mqttAdminErrorStatus(error);
    console.error("Error fetching MQTT rule:", error);
    return Response.json(
      {
        success: false,
        error: mqttAdminErrorMessage(error, "Failed to fetch MQTT rule"),
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
    const repository = await getMqttRuleAdminRepository();
    const rule = await repository.updateRule(await getRuleId(params), data);

    if (!rule) {
      return Response.json(
        { success: false, error: "Rule not found" },
        { status: 404 }
      );
    }

    return Response.json({ success: true, data: rule });
  } catch (error) {
    const status = mqttAdminErrorStatus(error);
    console.error("Error updating MQTT rule:", error);
    return Response.json(
      {
        success: false,
        error: mqttAdminErrorMessage(error, "Failed to update MQTT rule"),
      },
      { status }
    );
  }
}

export async function DELETE(_request, { params }) {
  const denied = await denyUnlessRoutePermission("mqtt.manage");
  if (denied) return denied;
  try {
    const repository = await getMqttRuleAdminRepository();
    const deleted = await repository.deleteRule(await getRuleId(params));

    if (!deleted) {
      return Response.json(
        { success: false, error: "Rule not found" },
        { status: 404 }
      );
    }

    return Response.json({ success: true });
  } catch (error) {
    const status = mqttAdminErrorStatus(error);
    console.error("Error deleting MQTT rule:", error);
    return Response.json(
      {
        success: false,
        error: mqttAdminErrorMessage(error, "Failed to delete MQTT rule"),
      },
      { status }
    );
  }
}
