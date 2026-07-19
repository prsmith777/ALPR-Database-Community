import {
  mqttAdminErrorMessage,
  mqttAdminErrorStatus,
  readJsonObject,
} from "@/lib/mqtt/admin-api.mjs";
import { getMqttRuleAdminRepository } from "@/lib/mqtt/admin-runtime.mjs";
import { getConfig } from "@/lib/settings";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

export async function GET() {
  const denied = await denyUnlessRoutePermission("mqtt.manage");
  if (denied) return denied;
  try {
    const repository = await getMqttRuleAdminRepository();
    const [rules, options, config] = await Promise.all([
      repository.listRules(),
      repository.listOptions(),
      getConfig(),
    ]);
    return Response.json({
      success: true,
      data: {
        rules,
        options: { ...options, plateMatching: config.plateMatching },
      },
    });
  } catch (error) {
    const status = mqttAdminErrorStatus(error);
    console.error("Error fetching MQTT rules:", error);
    return Response.json(
      {
        success: false,
        error: mqttAdminErrorMessage(error, "Failed to fetch MQTT rules"),
      },
      { status }
    );
  }
}

export async function POST(request) {
  const denied = await denyUnlessRoutePermission("mqtt.manage");
  if (denied) return denied;
  try {
    const data = await readJsonObject(request);
    const repository = await getMqttRuleAdminRepository();
    const rule = await repository.createRule(data);
    return Response.json({ success: true, data: rule }, { status: 201 });
  } catch (error) {
    const status = mqttAdminErrorStatus(error);
    console.error("Error creating MQTT rule:", error);
    return Response.json(
      {
        success: false,
        error: mqttAdminErrorMessage(error, "Failed to create MQTT rule"),
      },
      { status }
    );
  }
}
