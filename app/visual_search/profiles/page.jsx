import { redirect } from "next/navigation";

import { getVehicleReidAuthorityMode, getVehicleReidProfiles } from "@/app/actions";
import VehicleReidProfiles from "@/components/VehicleReidProfiles";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import { vehicleIntelligenceNavigationForMode } from "@/lib/vehicle-intelligence-navigation.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function positive(value, fallback) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export default async function VehicleProfilesPage({ searchParams }) {
  await requirePagePermission("plate.read");
  const parameters = await searchParams;
  const modeResult = await getVehicleReidAuthorityMode();
  const mode = modeResult?.success ? modeResult.data.control?.mode : "v1_primary";
  if (mode !== "v2_primary") redirect("/visual_search/vehicles");
  const search = String(parameters?.search || "").trim().slice(0, 80);
  const result = await getVehicleReidProfiles({
    page: positive(parameters?.page, 1),
    pageSize: positive(parameters?.pageSize, 24),
    search,
  });
  return (
    <DashboardLayout>
      <TitleNavbar title="Vehicle Intelligence" navigation={vehicleIntelligenceNavigationForMode(mode)}>
        <VehicleReidProfiles result={result} search={search} />
      </TitleNavbar>
    </DashboardLayout>
  );
}
