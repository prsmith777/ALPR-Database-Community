import VehicleIntelligenceSettings from "@/components/settings/VehicleIntelligenceSettings";
import {
  getBlueIrisVehicleFrameQueueStatus,
  getVehicleDirectionSetup,
} from "@/app/actions";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function VehicleIntelligencePage() {
  await requirePagePermission("system.manage_settings");
  const [result, frameQueue] = await Promise.all([
    getVehicleDirectionSetup(),
    getBlueIrisVehicleFrameQueueStatus(),
  ]);
  if (!result.success) throw new Error(result.error);
  return (
    <VehicleIntelligenceSettings
      initialData={result.data}
      initialFrameQueue={frameQueue.success ? frameQueue.data : null}
    />
  );
}
