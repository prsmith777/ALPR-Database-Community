import {
  getNotificationPlates,
  getNotificationRuleMigrationPreview,
} from "@/app/actions";
import { NotificationMigrationPreview } from "@/components/NotificationMigrationPreview";
import { NotificationsTable } from "@/components/NotificationsTable";
import DashboardLayout from "@/components/layout/MainLayout";
import BasicTitle from "@/components/layout/BasicTitle";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  await requirePagePermission("notification.manage");
  const [response, migrationPreviewResponse] = await Promise.all([
    getNotificationPlates(),
    getNotificationRuleMigrationPreview(),
  ]);
  const notificationPlates = response.success ? response.data : [];
  const migrationPreview = migrationPreviewResponse.success
    ? migrationPreviewResponse.data
    : null;

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
      </BasicTitle>
    </DashboardLayout>
  );
}
