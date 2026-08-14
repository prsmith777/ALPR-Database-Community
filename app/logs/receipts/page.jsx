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

async function ReceiptContent() {
  unstable_noStore();
  const response = await getIntegrationIngressReceipts();
  if (!response?.success) {
    return (
      <Alert variant="destructive" className="m-6">
        <AlertDescription>
          {response?.error || "Failed to read integration ingress receipts"}
        </AlertDescription>
      </Alert>
    );
  }
  return <IngressReceiptViewer initialPage={response.data} />;
}

export default async function IngressReceiptsPage() {
  await requirePagePermission("system.view_audit");
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
            <ReceiptContent />
          </Suspense>
        </div>
      </div>
    </DashboardLayout>
  );
}
