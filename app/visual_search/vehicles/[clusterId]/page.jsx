import { getVehicleProfile } from "@/app/actions";
import VehicleProfile from "@/components/VehicleProfile";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const navigation = [
  { title: "Visual Search", href: "/visual_search", permission: "plate.read" },
  { title: "Vehicle Profiles", href: "/visual_search/vehicles", permission: "plate.read" },
  { title: "Needs Review", href: "/visual_search/vehicles/review", permission: "plate.read" },
];

export default async function VehicleProfilePage({ params }) {
  await requirePagePermission("plate.read");
  const clusterId = Number((await params)?.clusterId);
  const result = await getVehicleProfile(clusterId);
  return (
    <DashboardLayout>
      <TitleNavbar title={result?.success ? `Vehicle #${result.data.id}` : "Vehicle profile"} navigation={navigation}>
        <VehicleProfile initialResult={result} />
      </TitleNavbar>
    </DashboardLayout>
  );
}
