import VehicleIntelligenceSettings from "@/components/settings/VehicleIntelligenceSettings";
import {
  getBlueIrisVehicleFrameQueueStatus,
  getVehicleEventShadowOverview,
  getVehicleImageCropOverview,
  getVehicleAssetEmbeddingOverview,
  getVehicleAssetAttributeOverview,
  getVehicleImageAssetCatalogOverview,
  getVehicleOverviewSetup,
  getVehicleDirectionSetup,
} from "@/app/actions";
import { requirePagePermission } from "@/lib/page-permission.mjs";

const EMPTY_BACKFILL = Object.freeze({
  eligible: 0,
  populated: 0,
  completed: 0,
  pending: 0,
  ready: 0,
  unknown: 0,
  failed: 0,
  imagesAwaitingIndex: 0,
  imageFailures: 0,
});

function directionDataFromOverview(overviewSetup) {
  const profiles = (overviewSetup?.plateCameras || []).map((camera) => ({
    cameraName: camera.cameraName,
    configured: camera.directions.length >= 2,
    enabled: true,
    frontDirectionLabel: camera.directions[0] || "",
    rearDirectionLabel: camera.directions[1] || "",
    minimumConfidence: 0.68,
    blueIrisMotionEnabled: false,
    blueIrisFrontTriggerType: "",
    blueIrisRearTriggerType: "",
    blueIrisMotionProfileVersion: 1,
    profileVersion: 1,
    frontCount: 0,
    rearCount: 0,
  }));
  return {
    classifierVersion: "",
    minimumSamplesPerView: 3,
    backfill: EMPTY_BACKFILL,
    blueIrisTriggerDirection: {
      received: 0,
      ready: 0,
      unknown: 0,
      unmapped: 0,
      latestAt: null,
      recent: [],
    },
    selectedCamera: profiles[0]?.cameraName || null,
    profiles,
    captures: [],
  };
}

function directionOptions(section) {
  return {
    includeBackfill: section === "processing",
    includeCaptures: section === "calibration",
    includeBlueIrisTriggerDirection: section === "cameras",
  };
}

export default async function VehicleIntelligenceSectionPage({ section = "cameras" }) {
  await requirePagePermission("system.manage_settings");

  if (section === "views") {
    const [frameQueue, overviewSetup] = await Promise.all([
      getBlueIrisVehicleFrameQueueStatus(),
      getVehicleOverviewSetup(),
    ]);
    const overviewData = overviewSetup.success ? overviewSetup.data : null;
    return (
      <VehicleIntelligenceSettings
        initialData={directionDataFromOverview(overviewData)}
        initialFrameQueue={frameQueue.success ? frameQueue.data : null}
        initialOverviewSetup={overviewData}
      />
    );
  }

  const [result, vehicleImageCatalog, vehicleEventShadow, vehicleImageCrops,
    vehicleAssetEmbeddings, vehicleAssetAttributes] = await Promise.all([
    getVehicleDirectionSetup(null, directionOptions(section)),
    section === "processing"
      ? getVehicleImageAssetCatalogOverview()
      : Promise.resolve(null),
    section === "processing"
      ? getVehicleEventShadowOverview()
      : Promise.resolve(null),
    section === "processing"
      ? getVehicleImageCropOverview()
      : Promise.resolve(null),
    section === "processing"
      ? getVehicleAssetEmbeddingOverview()
      : Promise.resolve(null),
    section === "processing"
      ? getVehicleAssetAttributeOverview()
      : Promise.resolve(null),
  ]);
  if (!result.success) throw new Error(result.error);
  return (
    <VehicleIntelligenceSettings
      initialData={result.data}
      initialFrameQueue={null}
      initialOverviewSetup={null}
      initialVehicleImageCatalog={vehicleImageCatalog?.success
        ? vehicleImageCatalog.data.overview
        : null}
      initialVehicleEventShadow={vehicleEventShadow?.success
        ? vehicleEventShadow.data.overview
        : null}
      initialVehicleImageCrops={vehicleImageCrops?.success
        ? vehicleImageCrops.data.overview
        : null}
      initialVehicleAssetEmbeddings={vehicleAssetEmbeddings?.success
        ? vehicleAssetEmbeddings.data.overview
        : null}
      initialVehicleAssetAttributes={vehicleAssetAttributes?.success
        ? vehicleAssetAttributes.data.overview
        : null}
    />
  );
}
