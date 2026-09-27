import { getVehicleReidReviewOverview } from "@/app/actions";
import VehicleReidLiveExceptions from "@/components/VehicleReidLiveExceptions";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import { VEHICLE_INTELLIGENCE_NAVIGATION } from "@/lib/vehicle-intelligence-navigation.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function VehicleReviewPage() {
  await requirePagePermission("plate.read");
  const result = await getVehicleReidReviewOverview();
  return (
    <DashboardLayout>
      <TitleNavbar title="Vehicle Intelligence" navigation={VEHICLE_INTELLIGENCE_NAVIGATION}>
        <VehicleReidLiveExceptions initialResult={result} />
      </TitleNavbar>
    </DashboardLayout>
  );
}

