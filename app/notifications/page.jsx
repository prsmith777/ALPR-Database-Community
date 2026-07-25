import {
  getNotificationPlates,
  getNotificationRuleBuilderOverview,
  getNotificationOperationsOverview,
  getNotificationRuleMigrationPreview,
  getUnifiedNotificationCutoverPreview,
  getUnifiedNotificationRuleReview,
} from "@/app/actions";
import { NotificationCutoverPanel } from "@/components/NotificationCutoverPanel";
import { NotificationMigrationPreview } from "@/components/NotificationMigrationPreview";
import { NotificationRuleDraftEditor } from "@/components/NotificationRuleDraftEditor";
import { NotificationRuleBuilder } from "@/components/NotificationRuleBuilder";
import { NotificationChannelTestPanel } from "@/components/NotificationChannelTestPanel";
import { NotificationOperationsPanel } from "@/components/NotificationOperationsPanel";
import { NotificationsTable } from "@/components/NotificationsTable";
import { UnifiedRuleShadowReview } from "@/components/UnifiedRuleShadowReview";
import DashboardLayout from "@/components/layout/MainLayout";
import BasicTitle from "@/components/layout/BasicTitle";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  await requirePagePermission("notification.manage");
  const [response, builderResponse, operationsResponse, migrationPreviewResponse, shadowReviewResponse, cutoverPreviewResponse] = await Promise.all([
    getNotificationPlates(),
    getNotificationRuleBuilderOverview(),
    getNotificationOperationsOverview(),
    getNotificationRuleMigrationPreview(),
    getUnifiedNotificationRuleReview(),
    getUnifiedNotificationCutoverPreview(),
  ]);
  const notificationPlates = response.success ? response.data : [];
  const builderOverview = builderResponse.success ? builderResponse.data : null;
  const operationsOverview = operationsResponse.success ? operationsResponse.data : null;
  const migrationPreview = migrationPreviewResponse.success
    ? migrationPreviewResponse.data
    : null;
  const shadowReview = shadowReviewResponse.success ? shadowReviewResponse.data : null;
  const cutoverPreview = cutoverPreviewResponse.success ? cutoverPreviewResponse.data : null;

  return (
    <DashboardLayout>
      <BasicTitle
        title="Notification Rules"
        subtitle="Create unified MQTT, Pushover, email, and signed webhook automations, preview them safely, and control activation from one place."
      >
        <div className="my-4">
          <NotificationRuleBuilder overview={builderOverview} />
        </div>
        <div className="my-8">
          <NotificationChannelTestPanel options={builderOverview?.options} />
        </div>
        <div className="my-8">
          <NotificationOperationsPanel overview={operationsOverview} />
        </div>
        <h2 className="my-4 ml-1 text-2xl font-medium text-zinc">
          Legacy exact-plate Pushover rules
        </h2>
        <NotificationsTable initialData={notificationPlates} />
        <div className="mt-8">
          <NotificationMigrationPreview preview={migrationPreview} />
        </div>
        <div className="mt-8">
          <NotificationRuleDraftEditor review={shadowReview} />
        </div>
        <div className="mt-8">
          <UnifiedRuleShadowReview review={shadowReview} />
        </div>
        <div className="mt-8">
          <NotificationCutoverPanel preview={cutoverPreview} />
        </div>
      </BasicTitle>
    </DashboardLayout>
  );
}
