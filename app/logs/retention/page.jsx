import { unstable_noStore } from "next/cache";

import { getLoggingRetentionOverview } from "@/app/actions";
import DashboardLayout from "@/components/layout/MainLayout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import { getLocalVersionInfo } from "@/lib/version";
import AuditHeader from "../AuditHeader";
import LoggingRetentionPanel from "./LoggingRetentionPanel";

export const dynamic = "force-dynamic";

export default async function LoggingRetentionPage() {
  unstable_noStore();
  const access = await requirePagePermission("system.view_audit");
  const [response, version] = await Promise.all([
    getLoggingRetentionOverview(),
    getLocalVersionInfo(),
  ]);

  return (
    <DashboardLayout>
      <div className="flex h-full flex-col">
        <AuditHeader active="retention" version={version} />
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {response?.success ? (
            <LoggingRetentionPanel
              initialOverview={response.data}
              canManage={access.permissions.includes("maintenance.manage")}
            />
          ) : (
            <Alert variant="destructive">
              <AlertDescription>
                {response?.error || "Unable to read logging retention health."}
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
