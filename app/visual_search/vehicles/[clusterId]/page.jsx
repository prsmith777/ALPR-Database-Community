import { redirect } from "next/navigation";

import { getVehicleProfile, getVehicleReidAuthorityMode } from "@/app/actions";
import VehicleProfile from "@/components/VehicleProfile";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import { vehicleIntelligenceNavigationForMode } from "@/lib/vehicle-intelligence-navigation.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function VehicleProfilePage({ params }) {
  await requirePagePermission("plate.read");
  const clusterId = Number((await params)?.clusterId);
  const modeResult = await getVehicleReidAuthorityMode();
  const mode = modeResult?.success ? modeResult.data.control?.mode : "v1_primary";
  // Legacy cluster IDs and stable v2 profile IDs are unrelated namespaces.
  // Never reinterpret one as the other during cutover.
  if (mode === "v2_primary") redirect("/visual_search/profiles");
  const result = await getVehicleProfile(clusterId);
  return (
    <DashboardLayout>
      <TitleNavbar title={result?.success ? `Legacy Vehicle #${result.data.id}` : "Legacy vehicle profile"} navigation={vehicleIntelligenceNavigationForMode(mode)}>
        <VehicleProfile initialResult={result} />
      </TitleNavbar>
    </DashboardLayout>
  );
}
