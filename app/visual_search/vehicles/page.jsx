import { getVehicleClusterOverview } from "@/app/actions";
import VehicleClusters from "@/components/VehicleClusters";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import { VEHICLE_INTELLIGENCE_NAVIGATION } from "@/lib/vehicle-intelligence-navigation.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function positivePage(value) {
  return Math.max(1, Number.parseInt(value, 10) || 1);
}

export default async function VehicleClustersPage({ searchParams }) {
  await requirePagePermission("plate.read");
  const parameters = await searchParams;
  const result = await getVehicleClusterOverview({
    view: "profiles",
    profilePage: positivePage(parameters?.profilesPage),
    vehicleReviewPage: positivePage(parameters?.vehicleReviewPage),
    plateReviewPage: positivePage(parameters?.plateReviewPage),
    directionReviewPage: positivePage(parameters?.directionReviewPage),
    profileStatus: parameters?.profileStatus || null,
    profileSearch: parameters?.profileSearch || null,
    profileCamera: parameters?.profileCamera || null,
  });
  return (
    <DashboardLayout>
      <TitleNavbar title="Vehicle Intelligence" navigation={VEHICLE_INTELLIGENCE_NAVIGATION}>
        <VehicleClusters initialResult={result} view="profiles" />
      </TitleNavbar>
    </DashboardLayout>
  );
}
