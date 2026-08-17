import { getVehicleProfile } from "@/app/actions";
import VehicleProfile from "@/components/VehicleProfile";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import { VEHICLE_INTELLIGENCE_NAVIGATION } from "@/lib/vehicle-intelligence-navigation.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function VehicleProfilePage({ params }) {
  await requirePagePermission("plate.read");
  const clusterId = Number((await params)?.clusterId);
  const result = await getVehicleProfile(clusterId);
  return (
    <DashboardLayout>
      <TitleNavbar title={result?.success ? `Legacy Vehicle #${result.data.id}` : "Legacy vehicle profile"} navigation={VEHICLE_INTELLIGENCE_NAVIGATION}>
        <VehicleProfile initialResult={result} />
      </TitleNavbar>
    </DashboardLayout>
  );
}
