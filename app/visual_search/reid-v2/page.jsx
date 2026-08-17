import { redirect } from "next/navigation";

import { getVehicleReidAuthorityMode, getVehicleReidV2Shadow } from "@/app/actions";
import VehicleReidV2Shadow from "@/components/VehicleReidV2Shadow";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import { vehicleIntelligenceNavigationForMode } from "@/lib/vehicle-intelligence-navigation.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export default async function VehicleReidV2ShadowPage({ searchParams }) {
  await requirePagePermission("plate.read");
  const parameters = await searchParams;
  const modeResult = await getVehicleReidAuthorityMode();
  const mode = modeResult?.success ? modeResult.data.control?.mode : "v1_primary";
  if (mode === "v2_primary") {
    const query = new URLSearchParams(Object.entries(parameters || {})
      .filter(([, value]) => typeof value === "string"));
    redirect(`/visual_search/review${query.size ? `?${query.toString()}` : ""}`);
  }
  const result = await getVehicleReidV2Shadow({
    page: positiveInteger(parameters?.page, 1),
    pageSize: positiveInteger(parameters?.pageSize, 12),
    resultLimit: positiveInteger(parameters?.resultLimit, 12),
    sourceDerivativeId: positiveInteger(parameters?.source, null),
    candidateDerivativeId: positiveInteger(parameters?.candidate, null),
    targetedReview: parameters?.targeted === "1",
    campaignReview: parameters?.campaign === "1",
    browseMode: parameters?.browse === "1",
    search: parameters?.search || "",
  });

  return (
    <DashboardLayout>
      <TitleNavbar title="Vehicle Intelligence" navigation={vehicleIntelligenceNavigationForMode(mode)}>
        <VehicleReidV2Shadow result={result} />
      </TitleNavbar>
    </DashboardLayout>
  );
}
