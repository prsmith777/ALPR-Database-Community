import { getVehicleReidProfile } from "@/app/actions";
import VehicleReidProfile from "@/components/VehicleReidProfile";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import { vehicleIntelligenceNavigationForMode } from "@/lib/vehicle-intelligence-navigation.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function VehicleProfilePage({ params }) {
  await requirePagePermission("plate.read");
  const values = await params;
  const result = await getVehicleReidProfile(values?.profileId);
  return (
    <DashboardLayout>
      <TitleNavbar title="Vehicle Intelligence" navigation={vehicleIntelligenceNavigationForMode()}>
        <VehicleReidProfile result={result} />
      </TitleNavbar>
    </DashboardLayout>
  );
}
