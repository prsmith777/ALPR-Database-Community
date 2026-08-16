import { getVehicleReidV2Shadow } from "@/app/actions";
import VehicleReidV2Shadow from "@/components/VehicleReidV2Shadow";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import { VEHICLE_INTELLIGENCE_NAVIGATION } from "@/lib/vehicle-intelligence-navigation.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export default async function VehicleReidV2ShadowPage({ searchParams }) {
  await requirePagePermission("plate.read");
  const parameters = await searchParams;
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
      <TitleNavbar title="Vehicle Intelligence" navigation={VEHICLE_INTELLIGENCE_NAVIGATION}>
        <VehicleReidV2Shadow result={result} />
      </TitleNavbar>
    </DashboardLayout>
  );
}
