import { Suspense } from "react";
import DashboardLayout from "@/components/layout/MainLayout";
import DashboardMetrics from "./DashboardMetrics";
import { DashboardSkeleton } from "@/components/DashboardSkeleton";

export default function Dashboard() {
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
