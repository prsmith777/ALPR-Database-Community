import {
  getNotificationRuleBuilderOverview,
  getNotificationOperationsOverview,
} from "@/app/actions";
import { NotificationRulesWorkspace } from "@/components/NotificationRulesWorkspace";
import DashboardLayout from "@/components/layout/MainLayout";
import BasicTitle from "@/components/layout/BasicTitle";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  await requirePagePermission("notification.manage");
  const [builderResponse, operationsResponse] = await Promise.all([
    getNotificationRuleBuilderOverview(),
    getNotificationOperationsOverview(),
  ]);
  const builderOverview = builderResponse.success ? builderResponse.data : null;
  const operationsOverview = operationsResponse.success ? operationsResponse.data : null;

  return (
    <DashboardLayout>
      <BasicTitle
        title="Notification Rules"
        subtitle="Decide when alerts should run and which configured integrations should receive them."
      >
        <div className="my-4"><NotificationRulesWorkspace builderOverview={builderOverview} operationsOverview={operationsOverview} /></div>
      </BasicTitle>
    </DashboardLayout>
  );
}
