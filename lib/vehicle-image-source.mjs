const text = (value) => String(value ?? "").trim();

export function normalizeVehicleImageSource(input = {}) {
  const sourceMode = text(input.sourceMode || "overview");
  const plateCameraName = text(input.plateCameraName);
  const directionLabel = text(input.directionLabel);
  const sourceCameraName = sourceMode === "lpr_camera" ? plateCameraName : text(input.sourceCameraName);
  const sourceCameraShortName = text(input.sourceCameraShortName);
  if (!["overview", "lpr_camera"].includes(sourceMode)) throw new Error("Choose a vehicle image source.");
  if (!plateCameraName || !directionLabel || !sourceCameraName) throw new Error("Choose a camera and a saved direction.");
  if (sourceMode === "overview" && sourceCameraName.toLowerCase() === plateCameraName.toLowerCase()) {
    throw new Error("Choose another camera for Overview camera, or select This LPR camera.");
  }
  if (!sourceCameraShortName) throw new Error("Select the matching Blue Iris camera. Test the Blue Iris connection to refresh the camera list.");
  const expectedDeltaMs = sourceMode === "lpr_camera" ? 0 : Number(input.expectedDeltaMs ?? 0);
  const toleranceMs = Number(input.toleranceMs ?? 1500);
  if (!Number.isInteger(expectedDeltaMs) || Math.abs(expectedDeltaMs) > 30000) throw new Error("Timing offset must be between -30 and 30 seconds.");
  if (!Number.isInteger(toleranceMs) || toleranceMs < 250 || toleranceMs > 3000) throw new Error("Timing tolerance must be between 0.25 and 3 seconds.");
  return { sourceMode, plateCameraName, directionLabel, sourceCameraName, sourceCameraShortName,
    expectedDeltaMs, toleranceMs, sourceRole: "primary", overviewContext: "street", priority: 0,
    enabled: input.enabled !== false };
}

export function vehicleImageSourceData(profile) {
  return { id: Number(profile.id), plateCameraName: profile.plate_camera_name,
    directionLabel: profile.direction_label, sourceMode: profile.source_mode || "overview",
    sourceCameraName: profile.source_camera_name, sourceCameraShortName: profile.source_camera_short_name || "",
    expectedDeltaMs: Number(profile.expected_delta_ms), toleranceMs: Number(profile.tolerance_ms),
    enabled: profile.enabled === true };
}
