import { createHash } from "node:crypto";

export const AXIS_MAX_BODY_BYTES = 32 * 1024 * 1024;
export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function text(value, limit = 255) {
  if (value != null && !["string", "number", "boolean"].includes(typeof value))
    throw new InputError("Invalid text field");
  const result = String(value ?? "").trim();
  if (result.length > limit || /[\u0000-\u001f]/.test(result))
    throw new InputError("Invalid text field");
  return result;
}
export function deviceKey(value) {
  const key = text(value, 64).replace(/[:-]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{4,64}$/.test(key))
    throw new InputError("Enter the camera serial number or MAC address");
  return key;
}
function image(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new InputError("Invalid image encoding");
  const encoded = value
    .replace(/^data:image\/(?:jpeg|jpg|png);base64,/i, "")
    .replace(/\s/g, "");
  if (
    encoded.length > AXIS_MAX_BODY_BYTES ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    encoded.length % 4 !== 0
  ) {
    throw new InputError("Invalid image encoding");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    !(bytes[0] === 0xff && bytes[1] === 0xd8) &&
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new InputError("Only JPEG and PNG event images are supported");
  }
  return encoded;
}
export function normalizeAxisEvent(payload, input) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object")
    throw new InputError("Expected an Axis event object");
  const mqtt = Boolean(payload.message?.data);
  if (mqtt && !/(?:^|\/)ALPV\.AllPlates$/.test(text(payload.topic, 512)))
    throw new InputError("Expected an ALPV.AllPlates event");
  const data = mqtt ? payload.message.data : payload;
  const plate = text(
    text(
      mqtt
        ? data.text
        : (data.plateText ?? data.plateUTF8 ?? data.plateUnicode),
      10,
    ).toUpperCase(),
    10,
  );
  if (!plate || !/^[\p{L}\p{N} -]+$/u.test(plate))
    throw new InputError("Invalid or missing plate number");
  const camera = deviceKey(
    mqtt
      ? data.MACAddress
      : (data.camera_info?.SerialNumber ?? data.camera_info?.MACAddress),
  );
  if (camera !== input.device_id)
    throw new InputError("Event camera does not match the configured camera");
  const carId = text(data.carID, 64);
  if (!carId) throw new InputError("Missing Axis carID");
  const state = text(data.carState, 12).toLowerCase();
  if (!["new", "update", "lost"].includes(state))
    throw new InputError("Unsupported Axis event state");
  const capturedMs = Number(text(data.capture_timestamp, 30));
  if (
    !Number.isSafeInteger(capturedMs) ||
    capturedMs < 946684800000 ||
    capturedMs > 8640000000000000
  )
    throw new InputError(
      "Invalid Axis capture timestamp (epoch milliseconds required)",
    );
  const direction = text(data.carMoveDirection || "unknown", 20).toLowerCase();
  const confidenceValue = mqtt ? data.lpConfidence : data.plateConfidence;
  const confidence =
    confidenceValue == null || confidenceValue === ""
      ? null
      : Number(text(confidenceValue, 30));
  if (
    confidence !== null &&
    (!Number.isFinite(confidence) || confidence < 0 || confidence > 100)
  )
    throw new InputError("Invalid plate confidence");
  const images = data.ImageArray ?? data.imageArray ?? [];
  if (!Array.isArray(images)) throw new InputError("Invalid Axis image array");
  const attachments = images.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new InputError("Invalid Axis image entry");
    return {
      type: (
        text(item.ImageType ?? item.imageType ?? "", 30) ||
        (index === 0 ? text(data.imageType, 30) : "")
      ).toLowerCase(),
      data: image(item.BinaryImage ?? item.binaryImage),
    };
  });
  const plateImage = mqtt
    ? image(data.lpImage)
    : (attachments.find((item) => /plate|^lp$|^21$/.test(item.type))?.data ??
      (data.imageType === "plate" ? attachments[0]?.data : null));
  const sceneImage = mqtt
    ? null
    : (attachments.find((item) => !/plate|^lp$|^21$/.test(item.type))?.data ??
      null);
  const metadata = {
    country: text(mqtt ? data.country : data.plateCountry, 10),
    region: text(mqtt ? data.region : data.plateRegion, 100),
    regionCode: text(mqtt ? data.regionCode : data.plateRegionCode, 30),
    iso3166: text(mqtt ? data["iso3166-2"] : data["plateISO3166-2"], 20),
    vehicle: mqtt
      ? {
          type: text(data.vehicleType, 60),
          color: text(data.vehicleColor, 60),
          make: text(data.vehicleMake, 60),
          model: text(data.vehicleModel, 60),
          view: text(data.view, 20),
        }
      : {
          type: text(data.vehicle_info?.type, 60),
          color: text(data.vehicle_info?.color, 60),
          make: text(data.vehicle_info?.make, 60),
          model: text(data.vehicle_info?.model, 60),
          view: text(data.vehicle_info?.view, 20),
        },
    action: text(data.action, 30),
  };
  const event = {
    plate,
    camera,
    carId,
    state,
    capturedMs,
    timestamp: new Date(capturedMs).toISOString(),
    direction,
    confidence,
    roi: text(data.roiID, 30),
    metadata,
  };
  event.fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        input.id,
        camera,
        carId,
        capturedMs,
        state,
        plate,
        direction,
        event.roi,
      ]),
    )
    .digest("hex");
  const primary = input.store_images ? (plateImage ?? sceneImage) : null;
  const scene = input.store_images && plateImage ? sceneImage : null;
  const digest = (value) =>
    value ? createHash("sha256").update(value).digest("hex") : null;
  return {
    ...event,
    image: primary,
    sceneImage: scene,
    imageDigest: digest(primary),
    sceneDigest: digest(scene),
  };
}

export function validateTopicFilter(value) {
  const filter = text(value, 512);
  if (!filter || filter.includes("\u0000") || filter.startsWith("$share/"))
    throw new InputError("Enter a valid MQTT topic filter");
  const levels = filter.split("/");
  if (
    levels.some(
      (level, index) =>
        (level.includes("+") && level !== "+") ||
        (level.includes("#") && (level !== "#" || index !== levels.length - 1)),
    )
  )
    throw new InputError("Invalid MQTT topic wildcard");
  return filter;
}
export function topicMatches(filter, topic) {
  const levels = filter.split("/");
  const actual = topic.split("/");
  if (topic.startsWith("$") && !filter.startsWith("$")) return false;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] === "#") return true;
    if (
      actual[i] === undefined ||
      (levels[i] !== "+" && levels[i] !== actual[i])
    )
      return false;
  }
  return levels.length === actual.length;
}

export async function readAxisRequest(request, maximum = AXIS_MAX_BODY_BYTES) {
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("Missing event body");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new InputError("Event body is too large", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const contentType = request.headers.get("content-type") || "application/json";
  const bytes = Buffer.concat(chunks);
  try {
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      const form = await new Response(bytes, {
        headers: { "content-type": contentType },
      }).formData();
      let event = null;
      const images = [];
      for (const [name, entry] of form.entries()) {
        const isJson =
          name === "event" ||
          name === "json" ||
          entry?.type === "application/json" ||
          /\.json$/i.test(entry?.name || "");
        if (isJson) {
          if (event) throw new InputError("Multiple event objects");
          event = JSON.parse(
            typeof entry === "string" ? entry : await entry.text(),
          );
        } else if (entry && typeof entry.arrayBuffer === "function") {
          images.push({
            ImageType: /(?:plate|(?:^|[_-])lp(?:[_-]|$)|image2)/i.test(
              name + " " + entry.name,
            )
              ? "plate"
              : "scene",
            main: name === "image",
            BinaryImage: Buffer.from(await entry.arrayBuffer()).toString(
              "base64",
            ),
          });
        }
      }
      if (!event)
        throw new InputError("Multipart request is missing its JSON event");
      return {
        ...event,
        ImageArray: [
          ...(event.ImageArray ?? event.imageArray ?? []),
          ...images.map(({ main, ...item }) => ({
            ...item,
            ImageType:
              main && event.imageType === "plate" ? "plate" : item.ImageType,
          })),
        ],
      };
    }
    if (!/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(contentType))
      throw new InputError("Use JSON or multipart/form-data", 415);
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("Invalid Axis event body");
  }
}
