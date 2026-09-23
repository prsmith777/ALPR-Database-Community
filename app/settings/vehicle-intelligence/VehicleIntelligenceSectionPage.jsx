import VehicleIntelligenceSettings from "@/components/settings/VehicleIntelligenceSettings";
import { getVehicleDirectionSetup } from "@/app/actions";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export default async function VehicleIntelligenceSectionPage() {
  await requirePagePermission("system.manage_settings");
  const result = await getVehicleDirectionSetup(null, {
    includeBackfill: false,
    includeCaptures: false,
    includeBlueIrisTriggerDirection: true,
  });
  if (!result.success) throw new Error(result.error);
  return <VehicleIntelligenceSettings initialData={result.data} />;
}
