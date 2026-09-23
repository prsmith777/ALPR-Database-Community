import { MqttAdmin } from "@/components/mqtt/MqttAdmin";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MqttIntegrationPage() {
  await requirePagePermission("mqtt.manage");
  return <MqttAdmin />;
}
