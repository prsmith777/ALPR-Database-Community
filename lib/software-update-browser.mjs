const RELEASE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

const UNFINISHED_UPDATE_STATUSES = new Set([
  "backed-up",
  "applying",
  "apply-failed",
  "validating",
  "validation-failed",
  "ready-for-acceptance",
  "rolling-back",
  "rollback-failed",
]);

const TECHNICAL_CHECK_STATUSES = new Set([
  "validating",
  "validation-failed",
  "ready-for-acceptance",
]);

const INSTALLATION_STATUSES = new Set([
  "backing-up",
  "backed-up",
  "backup-failed",
  "applying",
  "apply-failed",
]);

function normalizedVersion(value) {
  const version = String(value ?? "").trim();
  return RELEASE_VERSION.test(version) ? version : null;
}

export function shouldReloadForRunningRelease(renderedVersion, runningVersion) {
  const rendered = normalizedVersion(renderedVersion);
  const running = normalizedVersion(runningVersion);
  return Boolean(rendered && running && rendered !== running);
}

export function softwareUpdateReloadUrl(currentHref, runningVersion) {
  const running = normalizedVersion(runningVersion);
  if (!running) throw new Error("Running release version is invalid");
  const url = new URL(currentHref);
  url.searchParams.set("release", running);
  return url.toString();
}

export function availableReleaseLabel(state) {
  if (state?.targetTag) return state.targetTag;
  if (
    state?.operation === "check"
    && state?.phase === "succeeded"
    && state?.currentTag
  ) {
    return `${state.currentTag} (current)`;
  }
  return "Check required";
}

export function softwareUpdateWorkflow(state) {
  const updaterStatus = String(state?.updaterStatus || "");
  const updateAvailable = Boolean(
    state?.operation === "check"
    && state?.phase === "succeeded"
    && state?.targetTag
  );
  const unfinishedUpdate = UNFINISHED_UPDATE_STATUSES.has(updaterStatus);
  const technicalChecksAvailable = TECHNICAL_CHECK_STATUSES.has(updaterStatus);
  const acceptedNow = Boolean(
    state?.operation === "accept"
    && state?.phase === "succeeded"
    && updaterStatus === "accepted"
  );

  let currentStep = 1;
  let complete = false;
  if (acceptedNow) {
    currentStep = 4;
    complete = true;
  } else if (updaterStatus === "ready-for-acceptance") {
    currentStep = 4;
  } else if (TECHNICAL_CHECK_STATUSES.has(updaterStatus)) {
    currentStep = 3;
  } else if (INSTALLATION_STATUSES.has(updaterStatus) || updateAvailable) {
    currentStep = 2;
  }

  return Object.freeze({
    acceptedNow,
    canCheck: !unfinishedUpdate,
    canInstall: updateAvailable && !unfinishedUpdate,
    complete,
    currentStep,
    pendingAcceptance: updaterStatus === "ready-for-acceptance",
    technicalChecksAvailable,
    technicalChecksFailed: updaterStatus === "validation-failed",
    unfinishedUpdate,
    updateAvailable,
  });
}

export const softwareUpdateBrowserInternals = Object.freeze({
  INSTALLATION_STATUSES,
  TECHNICAL_CHECK_STATUSES,
  UNFINISHED_UPDATE_STATUSES,
  normalizedVersion,
});
