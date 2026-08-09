import crypto from "node:crypto";

const DEFAULT_TIMEOUT_SECONDS = 10;
const MIN_TIMEOUT_SECONDS = 2;
const MAX_TIMEOUT_SECONDS = 30;
const MAX_JPEG_BYTES = 12 * 1024 * 1024;

export class BlueIrisError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "BlueIrisError";
    this.code = code;
    this.details = options.details && typeof options.details === "object"
      ? options.details
      : null;
  }
}

function boundedTimeout(value) {
  const parsed = Number(value ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isInteger(parsed) || parsed < MIN_TIMEOUT_SECONDS || parsed > MAX_TIMEOUT_SECONDS) {
    throw new BlueIrisError(
      "INVALID_TIMEOUT",
      `Blue Iris timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds.`
    );
  }
  return parsed;
}

export function normalizeBlueIrisBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "Your Blue Iris Hostname or IP address") {
    throw new BlueIrisError("INVALID_HOST", "Enter the Blue Iris server address.");
  }

  let url;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new BlueIrisError("INVALID_HOST", "Enter a valid Blue Iris HTTP or HTTPS address.");
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BlueIrisError("INVALID_HOST", "Blue Iris must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new BlueIrisError(
      "INVALID_HOST",
      "Do not place Blue Iris credentials in the server address. Use the credential fields."
    );
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new BlueIrisError(
      "INVALID_HOST",
      "Enter only the Blue Iris server address and optional port, without a path or query string."
    );
  }

  return url.origin;
}

export function normalizeBlueIrisSettings(input = {}) {
  return {
    baseUrl: normalizeBlueIrisBaseUrl(input.host),
    username: String(input.username ?? "").trim(),
    password: String(input.password ?? ""),
    timeoutSeconds: boundedTimeout(input.timeout_seconds),
  };
}

function responseReason(response) {
  const data = response?.data;
  return String(
    (data && typeof data === "object" && (data.reason || data.error || data.message)) ||
      response?.reason ||
      ""
  ).trim();
}

function isAuthenticationFailure(response) {
  const reason = responseReason(response).toLowerCase();
  return [
    "invalid session",
    "access denied",
    "unauthorized",
    "not logged in",
    "authentication",
    "not authenticated",
  ].some((value) => reason.includes(value)) || reason === "login";
}

export function alertRecordsFromResponse(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data.filter((item) => item && typeof item === "object");
  if (data && typeof data === "object") {
    for (const key of ["alerts", "items", "records"]) {
      if (Array.isArray(data[key])) {
        return data[key].filter((item) => item && typeof item === "object");
      }
    }
  }
  return [];
}

function epochSeconds(value) {
  if (value instanceof Date) return value.getTime() / 1000;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1_000_000_000_000 ? value / 1000 : value;
  }
  const numeric = Number(value);
  if (String(value ?? "").trim() && Number.isFinite(numeric)) {
    return numeric >= 1_000_000_000_000 ? numeric / 1000 : numeric;
  }
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    throw new BlueIrisError("INVALID_TIMESTAMP", "Enter a valid alert timestamp.");
  }
  return parsed / 1000;
}

function recordTimestamp(record) {
  try {
    return epochSeconds(record?.date ?? record?.timestamp ?? record?.time);
  } catch {
    return null;
  }
}

function publicAlertRecord(record, deltaSeconds = null) {
  const timestamp = recordTimestamp(record);
  return {
    camera: record?.camera ?? record?.cam ?? record?.cameraName ?? null,
    timestamp: timestamp === null ? null : new Date(timestamp * 1000).toISOString(),
    clip: typeof record?.clip === "string" ? record.clip : null,
    file: typeof record?.file === "string" ? record.file : null,
    path: typeof record?.path === "string" ? record.path : null,
    offset: Number.isFinite(Number(record?.offset)) ? Number(record.offset) : null,
    msec: Number.isFinite(Number(record?.msec)) ? Number(record.msec) : null,
    duration: record?.duration ?? record?.filesize ?? null,
    memo: typeof record?.memo === "string" ? record.memo : null,
    deltaSeconds,
  };
}

export class BlueIrisClient {
  constructor(settings, { fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new BlueIrisError("FETCH_UNAVAILABLE", "HTTP requests are unavailable.");
    }
    this.settings = normalizeBlueIrisSettings(settings);
    this.fetchImpl = fetchImpl;
    this.sessionId = null;
    this.loginData = {};
  }

  async post(payload) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.settings.timeoutSeconds * 1000
    );
    try {
      const response = await this.fetchImpl(`${this.settings.baseUrl}/json`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response?.ok) {
        throw new BlueIrisError(
          "HTTP_ERROR",
          `Blue Iris returned HTTP ${response?.status || "error"}.`
        );
      }
      try {
        return await response.json();
      } catch {
        throw new BlueIrisError("INVALID_RESPONSE", "Blue Iris returned an invalid JSON response.");
      }
    } catch (error) {
      if (error instanceof BlueIrisError) throw error;
      if (error?.name === "AbortError") {
        throw new BlueIrisError("TIMEOUT", "Blue Iris did not respond before the timeout.");
      }
      throw new BlueIrisError("CONNECTION_FAILED", "Unable to reach the Blue Iris server.", {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async login({ force = false } = {}) {
    if (this.sessionId && !force) return this.loginData;
    if (!this.settings.username || !this.settings.password) {
      throw new BlueIrisError(
        "CREDENTIALS_REQUIRED",
        "Configure a Blue Iris username and password before connecting."
      );
    }

    const challenge = await this.post({ cmd: "login" });
    if (challenge?.result !== "fail" || !challenge?.session) {
      throw new BlueIrisError("LOGIN_FAILED", "Blue Iris did not return a login challenge.");
    }

    const token = crypto
      .createHash("md5")
      .update(`${this.settings.username}:${challenge.session}:${this.settings.password}`, "utf8")
      .digest("hex");
    const authenticated = await this.post({
      cmd: "login",
      session: challenge.session,
      response: token,
    });
    if (!authenticated || authenticated.result === "fail") {
      this.sessionId = null;
      throw new BlueIrisError("LOGIN_FAILED", "Blue Iris rejected the configured credentials.");
    }

    this.sessionId = authenticated.session || challenge.session;
    this.loginData = authenticated.data && typeof authenticated.data === "object"
      ? authenticated.data
      : {};
    return this.loginData;
  }

  async command(payload, { retryAuthentication = true } = {}) {
    await this.login();
    const response = await this.post({ ...payload, session: this.sessionId });
    if (response?.result !== "fail") return response;

    if (retryAuthentication && isAuthenticationFailure(response)) {
      this.sessionId = null;
      await this.login({ force: true });
      return this.command(payload, { retryAuthentication: false });
    }

    const reason = responseReason(response);
    throw new BlueIrisError(
      "COMMAND_FAILED",
      reason ? `Blue Iris rejected ${payload?.cmd || "the request"}: ${reason}` :
        `Blue Iris rejected ${payload?.cmd || "the request"}.`
    );
  }

  async fetchTimelineJpeg({ camera, timestamp, width = 1280, height = 720 }, {
    retryAuthentication = true,
  } = {}) {
    await this.login();
    const cameraId = String(camera ?? "").trim();
    if (!cameraId) {
      throw new BlueIrisError("CAMERA_REQUIRED", "Select a Blue Iris camera.");
    }
    const requestedWidth = Math.min(3840, Math.max(320, Number.parseInt(String(width), 10) || 1280));
    const requestedHeight = Math.min(2160, Math.max(180, Number.parseInt(String(height), 10) || 720));
    const positionMs = Math.round(epochSeconds(timestamp) * 1000);
    const url = new URL(`/time/${encodeURIComponent(cameraId)}`, this.settings.baseUrl);
    url.searchParams.set("pos", String(positionMs));
    url.searchParams.set("w", String(requestedWidth));
    url.searchParams.set("h", String(requestedHeight));
    url.searchParams.set("jpeg", "1");
    url.searchParams.set("mode", "jpeg");
    url.searchParams.set("isolate", "1");
    url.searchParams.set("session", this.sessionId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.timeoutSeconds * 1000);
    try {
      const response = await this.fetchImpl(url, { method: "GET", signal: controller.signal });
      if ([401, 403].includes(response?.status) && retryAuthentication) {
        this.sessionId = null;
        await this.login({ force: true });
        return this.fetchTimelineJpeg(
          { camera: cameraId, timestamp, width: requestedWidth, height: requestedHeight },
          { retryAuthentication: false }
        );
      }
      if ([404, 410].includes(response?.status)) {
        throw new BlueIrisError(
          "RECORDING_UNAVAILABLE",
          "Blue Iris no longer has recording data for this time."
        );
      }
      if (!response?.ok) {
        throw new BlueIrisError("HTTP_ERROR", `Blue Iris returned HTTP ${response?.status || "error"}.`);
      }
      const contentLength = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_JPEG_BYTES) {
        throw new BlueIrisError("FRAME_TOO_LARGE", "Blue Iris returned an unexpectedly large frame.");
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 4 || buffer.length > MAX_JPEG_BYTES
        || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) {
        throw new BlueIrisError(
          "RECORDING_UNAVAILABLE",
          "Blue Iris did not return a JPEG frame for this time."
        );
      }
      return { buffer, timestamp: new Date(positionMs).toISOString(), positionMs };
    } catch (error) {
      if (error instanceof BlueIrisError) throw error;
      if (error?.name === "AbortError") {
        throw new BlueIrisError("TIMEOUT", "Blue Iris did not return the frame before the timeout.");
      }
      throw new BlueIrisError("CONNECTION_FAILED", "Unable to retrieve a frame from Blue Iris.", {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async testConnection() {
    const loginData = await this.login();
    const response = await this.command({ cmd: "camlist" });
    const cameras = Array.isArray(response?.data)
      ? response.data
          .filter((camera) => camera && typeof camera === "object")
          .map((camera) => ({
            id: String(camera.optionValue ?? camera.id ?? "").trim(),
            name: String(camera.optionDisplay ?? camera.name ?? camera.optionValue ?? "").replace(/^\+/, "").trim(),
            online: camera.isOnline === true,
            enabled: camera.isEnabled !== false,
          }))
          .filter((camera) => camera.id)
      : [];
    return {
      systemName: loginData.systemName || loginData.name || null,
      version: loginData.version || null,
      cameraCount: cameras.length,
      cameras,
    };
  }

  async listAlerts({ camera, start, end }) {
    const startdate = Math.floor(epochSeconds(start));
    const enddate = Math.ceil(epochSeconds(end));
    if (!String(camera ?? "").trim()) {
      throw new BlueIrisError("CAMERA_REQUIRED", "Select a Blue Iris camera.");
    }
    if (enddate < startdate) {
      throw new BlueIrisError("INVALID_TIME_RANGE", "The alert end time must follow its start time.");
    }
    const response = await this.command({
      cmd: "alertlist",
      camera: String(camera).trim(),
      view: "alerts",
      startdate,
      enddate,
    });
    return alertRecordsFromResponse(response);
  }

  async findNearestAlert({ camera, timestamp, toleranceSeconds = 90 }) {
    const target = epochSeconds(timestamp);
    const tolerance = Number(toleranceSeconds);
    if (!Number.isFinite(tolerance) || tolerance < 1 || tolerance > 900) {
      throw new BlueIrisError(
        "INVALID_TOLERANCE",
        "Alert matching tolerance must be between 1 and 900 seconds."
      );
    }
    const records = await this.listAlerts({
      camera,
      start: target - tolerance,
      end: target + tolerance,
    });
    const candidates = records
      .map((record) => ({ record, timestamp: recordTimestamp(record) }))
      .filter((candidate) => candidate.timestamp !== null)
      .map((candidate) => ({
        ...candidate,
        deltaSeconds: Math.abs(candidate.timestamp - target),
      }))
      .sort((left, right) => left.deltaSeconds - right.deltaSeconds);
    const nearest = candidates[0];
    return {
      searchedCount: records.length,
      matched: Boolean(nearest && nearest.deltaSeconds <= tolerance),
      alert: nearest && nearest.deltaSeconds <= tolerance
        ? publicAlertRecord(nearest.record, nearest.deltaSeconds)
        : null,
    };
  }
}

export const blueIrisInternals = Object.freeze({
  boundedTimeout,
  epochSeconds,
  isAuthenticationFailure,
  publicAlertRecord,
  recordTimestamp,
  responseReason,
  MAX_JPEG_BYTES,
});
