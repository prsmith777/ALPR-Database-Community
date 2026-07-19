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
        subtitle="Configure brokers, per-camera topics, matching rules, tests, and delivery activity."
      >
        <MqttAdmin />
      </BasicTitle>
    </DashboardLayout>
  );
}
