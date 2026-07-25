import { MqttAdmin } from "@/components/mqtt/MqttAdmin";
import DashboardLayout from "@/components/layout/MainLayout";
import BasicTitle from "@/components/layout/BasicTitle";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MqttPage() {
  await requirePagePermission("mqtt.manage");
  return (
    <DashboardLayout>
      <BasicTitle
        title="MQTT"
        subtitle="Configure brokers and per-camera topics, then test and review MQTT delivery activity. Notification rules are managed on Notifications."
      >
        <MqttAdmin />
      </BasicTitle>
    </DashboardLayout>
  );
}
