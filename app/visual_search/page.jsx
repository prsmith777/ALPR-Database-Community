import { redirect } from "next/navigation";

import {
  getVehicleReidAuthorityMode,
  getVehicleReidV2Shadow,
  getVisualSearchBootstrap,
  resolveVehicleReidRead,
} from "@/app/actions";
import VisualSearch from "@/components/VisualSearch";
import VehicleReidV2Shadow from "@/components/VehicleReidV2Shadow";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import { vehicleIntelligenceNavigationForMode } from "@/lib/vehicle-intelligence-navigation.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function VisualSearchPage({ searchParams }) {
  await requirePagePermission("plate.read");
  const parameters = await searchParams;
  const modeResult = await getVehicleReidAuthorityMode();
  const mode = modeResult?.success ? modeResult.data.control?.mode : "v1_primary";
  const navigation = vehicleIntelligenceNavigationForMode(mode);
  if (mode === "v2_primary") {
    let sourceDerivativeId = Number.parseInt(String(parameters?.source || ""), 10);
    let resolutionMessage = "";
    const requestedReadId = Number.parseInt(String(parameters?.readId || ""), 10);
    if (Number.isSafeInteger(requestedReadId) && requestedReadId > 0) {
      const resolved = await resolveVehicleReidRead(requestedReadId);
      if (resolved?.success && resolved.data.currentIdentityLink && resolved.data.derivativeId) {
        sourceDerivativeId = resolved.data.derivativeId;
      } else if (resolved?.success && resolved.data.profileId) {
        redirect(`/visual_search/profiles/${resolved.data.profileId}`);
      } else {
        resolutionMessage = "This read has no exact current identity-eligible Vehicle View or authoritative ReID profile. Find Similar is unavailable.";
      }
    }
    const result = await getVehicleReidV2Shadow({
      page: Number.parseInt(String(parameters?.page || "1"), 10) || 1,
      pageSize: Number.parseInt(String(parameters?.pageSize || "12"), 10) || 12,
      resultLimit: Number.parseInt(String(parameters?.resultLimit || "12"), 10) || 12,
      sourceDerivativeId: Number.isSafeInteger(sourceDerivativeId) && sourceDerivativeId > 0
        ? sourceDerivativeId
        : null,
      browseMode: true,
      primaryBrowse: true,
      search: parameters?.search || "",
    });
    return (
      <DashboardLayout>
        <TitleNavbar title="Vehicle Intelligence" navigation={navigation}>
          {resolutionMessage ? (
            <div className="mb-5 rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
              {resolutionMessage}
            </div>
          ) : null}
          <VehicleReidV2Shadow result={result} routeBase="/visual_search" primaryMode />
        </TitleNavbar>
      </DashboardLayout>
    );
  }

  const bootstrap = await getVisualSearchBootstrap();

  return (
    <DashboardLayout>
      <TitleNavbar title="Vehicle Intelligence" navigation={navigation}>
        <VisualSearch
          initialResult={bootstrap}
          initialReadId={parameters?.readId || ""}
        />
      </TitleNavbar>
    </DashboardLayout>
  );
}
