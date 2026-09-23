import { redirect } from "next/navigation";

import { getVehicleReidAuthorityMode, getVehicleReidProfile } from "@/app/actions";
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
  const modeResult = await getVehicleReidAuthorityMode();
  const mode = modeResult?.success ? modeResult.data.control?.mode : "v1_primary";
  // A v2 profile ID is not a legacy cluster ID. Rollback returns to the
  // legacy list without fabricating an identity translation.
  if (mode !== "v2_primary") redirect("/visual_search/vehicles");
  const result = await getVehicleReidProfile(values?.profileId);
  return (
    <DashboardLayout>
      <TitleNavbar title="Vehicle Intelligence" navigation={vehicleIntelligenceNavigationForMode(mode)}>
        <VehicleReidProfile result={result} />
      </TitleNavbar>
    </DashboardLayout>
  );
}
