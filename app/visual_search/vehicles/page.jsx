import { getVehicleClusterOverview } from "@/app/actions";
import VehicleClusters from "@/components/VehicleClusters";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const navigation = [
  { title: "Visual Search", href: "/visual_search", permission: "plate.read" },
  { title: "Vehicle Profiles", href: "/visual_search/vehicles", permission: "plate.read" },
];

function positivePage(value) {
  return Math.max(1, Number.parseInt(value, 10) || 1);
}

export default async function VehicleClustersPage({ searchParams }) {
  await requirePagePermission("plate.read");
  const parameters = await searchParams;
  const result = await getVehicleClusterOverview({
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
      <TitleNavbar title="Vehicle Intelligence" navigation={navigation}>
        <VehicleClusters initialResult={result} />
      </TitleNavbar>
    </DashboardLayout>
  );
}
