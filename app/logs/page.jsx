import { Suspense } from "react";
import { unstable_noStore } from "next/cache";

import { getSystemLogs } from "@/app/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import DashboardLayout from "@/components/layout/MainLayout";
import { getLocalVersionInfo } from "@/lib/version";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import AuditHeader from "./AuditHeader";
import LogViewer from "./LogViewer";

export const dynamic = "force-dynamic";

async function LogsContent({ initialFilters }) {
  unstable_noStore();
  const { data: logs, error } = await getSystemLogs(initialFilters);

  if (error) {
    return (
      <Alert variant="destructive" className="mx-6">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return <LogViewer initialPage={logs} initialFilters={initialFilters} />;
}

export default async function LogsPage({ searchParams }) {
  await requirePagePermission("system.view_audit");
  const parameters = await searchParams;
  const requestedReadId = Array.isArray(parameters?.readId)
    ? parameters.readId[0]
    : parameters?.readId;
  const requestedRequestId = Array.isArray(parameters?.requestId)
    ? parameters.requestId[0]
    : parameters?.requestId;
  const readId = /^\d+$/.test(String(requestedReadId || ""))
    ? String(requestedReadId)
    : "";
  const requestId = String(requestedRequestId || "").trim().slice(0, 128);
  const initialFilters = {
    ...(readId ? { readId } : {}),
    ...(requestId ? { requestId } : {}),
  };
  const version = await getLocalVersionInfo();

  return (
    <DashboardLayout>
      <div className="flex h-full flex-col">
        <AuditHeader active="logs" version={version} />

        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
              </div>
            }
          >
            <LogsContent initialFilters={initialFilters} />
          </Suspense>
        </div>
      </div>
    </DashboardLayout>
  );
}
