import {
  getNotificationRuleBuilderOverview,
  getNotificationOperationsOverview,
  getNotificationLegacyFinalizationPreview,
  getNotificationRuleMigrationPreview,
  getUnifiedNotificationCutoverPreview,
  getUnifiedNotificationRuleReview,
} from "@/app/actions";
import { NotificationCutoverPanel } from "@/components/NotificationCutoverPanel";
import { NotificationMigrationPreview } from "@/components/NotificationMigrationPreview";
import { NotificationLegacyFinalizationPanel } from "@/components/NotificationLegacyFinalizationPanel";
import { NotificationRuleDraftEditor } from "@/components/NotificationRuleDraftEditor";
import { NotificationRuleBuilder } from "@/components/NotificationRuleBuilder";
import { NotificationChannelTestPanel } from "@/components/NotificationChannelTestPanel";
import { NotificationOperationsPanel } from "@/components/NotificationOperationsPanel";
import { UnifiedRuleShadowReview } from "@/components/UnifiedRuleShadowReview";
import DashboardLayout from "@/components/layout/MainLayout";
import BasicTitle from "@/components/layout/BasicTitle";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  await requirePagePermission("notification.manage");
  const [builderResponse, operationsResponse, migrationPreviewResponse, shadowReviewResponse, cutoverPreviewResponse, finalizationResponse] = await Promise.all([
    getNotificationRuleBuilderOverview(),
    getNotificationOperationsOverview(),
    getNotificationRuleMigrationPreview(),
    getUnifiedNotificationRuleReview(),
    getUnifiedNotificationCutoverPreview(),
    getNotificationLegacyFinalizationPreview(),
  ]);
  const builderOverview = builderResponse.success ? builderResponse.data : null;
  const operationsOverview = operationsResponse.success ? operationsResponse.data : null;
  const migrationPreview = migrationPreviewResponse.success
    ? migrationPreviewResponse.data
    : null;
  const shadowReview = shadowReviewResponse.success ? shadowReviewResponse.data : null;
  const cutoverPreview = cutoverPreviewResponse.success ? cutoverPreviewResponse.data : null;
  const finalizationPreview = finalizationResponse.success ? finalizationResponse.data : null;

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
        <div className="mt-8">
          <NotificationLegacyFinalizationPanel preview={finalizationPreview} />
        </div>
      </BasicTitle>
    </DashboardLayout>
  );
}
