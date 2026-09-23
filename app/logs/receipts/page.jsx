import { Suspense } from "react";
import { unstable_noStore } from "next/cache";

import { getIntegrationIngressReceipts } from "@/app/actions";
import DashboardLayout from "@/components/layout/MainLayout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import { getLocalVersionInfo } from "@/lib/version";
import AuditHeader from "../AuditHeader";
import IngressReceiptViewer from "./IngressReceiptViewer";

export const dynamic = "force-dynamic";

async function ReceiptContent({ initialFilters, initialExpandFirst }) {
  unstable_noStore();
  const response = await getIntegrationIngressReceipts(initialFilters);
  if (!response?.success) {
    return (
      <Alert variant="destructive" className="m-6">
        <AlertDescription>
          {response?.error || "Failed to read integration ingress receipts"}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <IngressReceiptViewer
      initialPage={response.data}
      initialFilters={initialFilters}
      initialExpandFirst={initialExpandFirst}
    />
  );
}

export default async function IngressReceiptsPage({ searchParams }) {
  await requirePagePermission("system.view_audit");
  const parameters = await searchParams;
  const requestedRequestId = Array.isArray(parameters?.requestId)
    ? parameters.requestId[0]
    : parameters?.requestId;
  const requestId = String(requestedRequestId || "").trim().slice(0, 128);
  const initialFilters = requestId ? { requestId } : {};
  const initialExpandFirst = parameters?.expand === "first";
  const version = await getLocalVersionInfo();

  return (
    <DashboardLayout>
      <div className="flex h-full flex-col">
        <AuditHeader active="receipts" version={version} />
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
              </div>
            }
          >
            <ReceiptContent
              initialFilters={initialFilters}
              initialExpandFirst={initialExpandFirst}
            />
          </Suspense>
        </div>
      </div>
    </DashboardLayout>
  );
}
