import { getVehicleClusterOverview } from "@/app/actions";
import VehicleClusters from "@/components/VehicleClusters";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const navigation = [
  { title: "Visual Search", href: "/visual_search", permission: "plate.read" },
  { title: "Vehicle Clusters", href: "/visual_search/vehicles", permission: "plate.read" },
];

export default async function VehicleClustersPage() {
  await requirePagePermission("plate.read");
  const result = await getVehicleClusterOverview();
  return (
    <DashboardLayout>
      <TitleNavbar title="Vehicle Intelligence" navigation={navigation}>
        <VehicleClusters initialResult={result} />
      </TitleNavbar>
    </DashboardLayout>
  );
}
