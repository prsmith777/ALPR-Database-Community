import { Suspense } from "react";
import DashboardLayout from "@/components/layout/MainLayout";
import DashboardMetrics from "./DashboardMetrics";
import { DashboardSkeleton } from "@/components/DashboardSkeleton";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  await requirePagePermission("plate.read");
  return (
    <DashboardLayout>
      <div className="space-y-8 p-6">
        <Suspense fallback={<DashboardSkeleton />}>
          <DashboardMetrics />
        </Suspense>
      </div>
    </DashboardLayout>
  );
}
