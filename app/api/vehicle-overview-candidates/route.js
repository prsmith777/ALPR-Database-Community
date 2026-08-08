import { getPool } from "@/lib/db";
import { parseBlueIrisAlertPointer } from "@/lib/blue-iris-alert-pointer.mjs";
import { BlueIrisVehicleFrameRepository } from "@/lib/blue-iris-vehicle-frame-repository.mjs";
import { wakeBlueIrisVehicleFrameWorker } from "@/lib/blue-iris-vehicle-frame-runtime.mjs";
import { assessDirectionImageEligibility } from "@/lib/direction-image-eligibility.mjs";
import { createIntegrationRouteHandler } from "@/lib/request-auth.mjs";
import {
  createOverviewCandidateIdentity,
  normalizeOverviewTriggerType,
  overviewNighttimeState,
} from "@/lib/vehicle-overview-candidate.mjs";

async function processOverviewCandidate(data) {
  const sourceCameraName = String(data?.camera || data?.camera_name || "").trim();
  if (!sourceCameraName) {
    return Response.json({ error: "A Blue Iris camera name is required" }, { status: 400 });
  }
  const eventTimestamp = new Date(data?.timestamp || "");
  if (!Number.isFinite(eventTimestamp.getTime())) {
    return Response.json({ error: "A valid Blue Iris alert timestamp is required" }, { status: 400 });
  }

  let eligibility;
  try {
    eligibility = await assessDirectionImageEligibility(data?.Image);
  } catch {
    return Response.json({ error: "The alert JPEG could not be evaluated" }, { status: 400 });
  }
  const daylight = overviewNighttimeState(eligibility);
  if (!daylight.accepted) {
    return Response.json(
      { error: "A Blue Iris alert JPEG is required to enforce daytime-only overview processing" },
      { status: 400 }
    );
  }

  const alert = parseBlueIrisAlertPointer({
    clip: data?.ALERT_CLIP,
    path: data?.ALERT_PATH,
    camera: sourceCameraName,
  });
  const eventIdentity = createOverviewCandidateIdentity({
    sourceCameraName,
    eventTimestamp,
    alertClip: alert.alertClip,
    alertPath: alert.alertPath,
  });
  const repository = new BlueIrisVehicleFrameRepository(await getPool());
  const sourceProfiles = await repository.listOverviewPairProfiles(sourceCameraName);
  if (!sourceProfiles.some((profile) => profile.enabled === true)) {
    return Response.json(
      { error: "This overview source camera is not enabled in Vehicle Views" },
      { status: 409 }
    );
  }
  const candidate = await repository.createOverviewCandidate({
    eventIdentity,
    sourceCameraName,
    eventTimestamp: eventTimestamp.toISOString(),
    alertClip: alert.alertClip,
    alertPath: alert.alertPath,
    alertOffsetMs: alert.offsetMs,
    triggerType: normalizeOverviewTriggerType(data?.trigger_type ?? data?.triggerType ?? data?.TYPE),
    daylightStatus: daylight.daylightStatus,
    monochromeRatio: eligibility.monochromeRatio,
    status: daylight.status,
    retryable: daylight.retryable,
    errorCode: daylight.errorCode,
  });
  if (daylight.status === "pending") wakeBlueIrisVehicleFrameWorker();
  return Response.json({
    accepted: true,
    duplicate: candidate?.duplicate === true,
    candidateId: Number(candidate?.id),
    status: candidate?.status,
    vehicleView: candidate?.error_code === "NIGHTTIME_UNAVAILABLE"
      ? "Unavailable nighttime"
      : "Queued for daytime overview screening",
  }, { status: candidate?.duplicate === true ? 200 : 201 });
}

export const POST = createIntegrationRouteHandler(processOverviewCandidate);
