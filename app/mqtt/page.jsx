import { MqttAdmin } from "@/components/mqtt/MqttAdmin";
import DashboardLayout from "@/components/layout/MainLayout";
import BasicTitle from "@/components/layout/BasicTitle";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function MqttPage() {
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
