import { redirect } from "next/navigation";

import {
  getVehicleReidAuthorityMode,
  getVehicleReidReviewOverview,
  getVehicleReidV2Shadow,
} from "@/app/actions";
import VehicleReidV2Shadow from "@/components/VehicleReidV2Shadow";
import VehicleReidLiveExceptions from "@/components/VehicleReidLiveExceptions";
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

export default async function VehicleReviewPage({ searchParams }) {
  await requirePagePermission("plate.read");
  const parameters = await searchParams;
  const modeResult = await getVehicleReidAuthorityMode();
  const mode = modeResult?.success ? modeResult.data.control?.mode : "v1_primary";
  if (mode !== "v2_primary") redirect("/visual_search/vehicles/review");
  const [result, exceptions] = await Promise.all([
    getVehicleReidV2Shadow({
      page: positive(parameters?.page, 1),
      pageSize: positive(parameters?.pageSize, 12),
      resultLimit: positive(parameters?.resultLimit, 12),
      sourceDerivativeId: positive(parameters?.source, null),
      candidateDerivativeId: positive(parameters?.candidate, null),
      targetedReview: parameters?.targeted === "1",
      campaignReview: parameters?.campaign === "1",
      browseMode: parameters?.browse === "1",
      search: parameters?.search || "",
    }),
    getVehicleReidReviewOverview(),
  ]);
  return (
    <DashboardLayout>
      <TitleNavbar title="Vehicle Intelligence" navigation={vehicleIntelligenceNavigationForMode(mode)}>
        <div className="space-y-6">
          <VehicleReidLiveExceptions initialResult={exceptions} />
          <VehicleReidV2Shadow result={result} routeBase="/visual_search/review" reviewMode />
        </div>
      </TitleNavbar>
    </DashboardLayout>
  );
}
