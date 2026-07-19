import { Suspense } from "react";
import { unstable_noStore } from "next/cache";
import { getSystemLogs } from "@/app/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import LogViewer from "./LogViewer";
import DashboardLayout from "@/components/layout/MainLayout";
import { getLocalVersionInfo } from "@/lib/version";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import {
  PROJECT_NAME,
  PROJECT_RELEASES_URL,
} from "@/lib/project-info";

async function LogsContent() {
  unstable_noStore();
  const { data: logs, error } = await getSystemLogs();

  if (error) {
    return (
      <Alert variant="destructive" className="mx-6">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return <LogViewer initialLogs={logs} />;
}

export default async function LogsPage() {
  await requirePagePermission("system.view_audit");
  const version = await getLocalVersionInfo();

  return (
    <DashboardLayout>
      <div className="flex flex-col h-full">
        {/* Header - Fixed height */}
        <div className="flex-shrink-0 border-b bg-background">
          <div className="flex h-16 items-center justify-between px-6">
            <h1 className="text-lg font-medium text-foreground">System Logs</h1>
            <a
              href={PROJECT_RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              {PROJECT_NAME} · v{version}
            </a>
          </div>
        </div>

        {/* Content - Takes remaining height */}
        <div className="flex-1 min-h-0">
          <Suspense
            fallback={
              <div className="flex justify-center items-center h-full">
                <div className="animate-spin rounded-full w-8 h-8 border-b-2 border-primary" />
              </div>
            }
          >
            <LogsContent />
          </Suspense>
        </div>
      </div>
    </DashboardLayout>
  );
}
