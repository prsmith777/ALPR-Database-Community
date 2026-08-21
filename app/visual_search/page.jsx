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
import { parseVehicleReidV2SearchId } from "@/lib/vehicle-reid-v2-search-input.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function VisualSearchPage({ searchParams }) {
  await requirePagePermission("plate.read");
  const parameters = await searchParams;
  const modeResult = await getVehicleReidAuthorityMode();
  const mode = modeResult?.success ? modeResult.data.control?.mode : null;
  if (!modeResult?.success || !["v1_primary", "v1_rollback", "v2_primary"].includes(mode)) {
    return (
      <DashboardLayout>
        <TitleNavbar title="Vehicle Intelligence" navigation={[]}>
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            {modeResult?.error || "Unable to determine the current ReID authority mode. Vehicle Search is unavailable."}
          </div>
        </TitleNavbar>
      </DashboardLayout>
    );
  }
  const navigation = vehicleIntelligenceNavigationForMode(mode);
  if (mode === "v2_primary") {
    const requestedSource = parseVehicleReidV2SearchId(parameters?.source);
    let sourceDerivativeId = requestedSource.value;
    let resolutionMessage = "";
    let suppressDefaultSelection = requestedSource.present && !requestedSource.valid;
    const requestedRead = parseVehicleReidV2SearchId(parameters?.readId);
    if (requestedRead.present) {
      sourceDerivativeId = null;
      if (requestedRead.valid) {
        const resolved = await resolveVehicleReidRead(requestedRead.value);
        if (resolved?.success && resolved.data.currentIdentityLink && resolved.data.derivativeId) {
          sourceDerivativeId = resolved.data.derivativeId;
        } else if (resolved?.success && resolved.data.profileId) {
          redirect(`/visual_search/profiles/${resolved.data.profileId}`);
        } else {
          suppressDefaultSelection = true;
          resolutionMessage = "This read has no exact current identity-eligible Vehicle View or authoritative ReID profile. Find Similar is unavailable.";
        }
      } else {
        suppressDefaultSelection = true;
        resolutionMessage = "This read link is invalid. Find Similar is unavailable.";
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
      suppressDefaultSelection,
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
