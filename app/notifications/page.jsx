import {
  getNotificationPlates,
  getNotificationRuleMigrationPreview,
  getUnifiedNotificationCutoverPreview,
  getUnifiedNotificationRuleReview,
} from "@/app/actions";
import { NotificationCutoverPanel } from "@/components/NotificationCutoverPanel";
import { NotificationMigrationPreview } from "@/components/NotificationMigrationPreview";
import { NotificationRuleDraftEditor } from "@/components/NotificationRuleDraftEditor";
import { NotificationsTable } from "@/components/NotificationsTable";
import { UnifiedRuleShadowReview } from "@/components/UnifiedRuleShadowReview";
import DashboardLayout from "@/components/layout/MainLayout";
import BasicTitle from "@/components/layout/BasicTitle";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  await requirePagePermission("notification.manage");
  const [response, migrationPreviewResponse, shadowReviewResponse, cutoverPreviewResponse] = await Promise.all([
    getNotificationPlates(),
    getNotificationRuleMigrationPreview(),
    getUnifiedNotificationRuleReview(),
    getUnifiedNotificationCutoverPreview(),
  ]);
  const notificationPlates = response.success ? response.data : [];
  const migrationPreview = migrationPreviewResponse.success
    ? migrationPreviewResponse.data
    : null;
  const shadowReview = shadowReviewResponse.success ? shadowReviewResponse.data : null;
  const cutoverPreview = cutoverPreviewResponse.success ? cutoverPreviewResponse.data : null;

  return (
    <DashboardLayout>
      <BasicTitle
        title="Plate Recognition Notifications"
        subtitle="Configure Pushover alerts for recognition of specific plates. MQTT automation is configured on the dedicated MQTT page."
      >
        <h2 className="my-4 ml-1 text-2xl font-medium text-zinc">
          Push Notifications
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
