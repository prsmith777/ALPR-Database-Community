const RELEASE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

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

export const softwareUpdateBrowserInternals = Object.freeze({ normalizedVersion });
