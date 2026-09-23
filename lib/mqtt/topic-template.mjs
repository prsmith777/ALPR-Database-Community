import { isValidCameraKey } from "./plate-normalize.mjs";

export const DEFAULT_BASE_TOPIC = "Blue Iris/ALPR";
export const DEFAULT_CAMERA_TOPIC_TEMPLATE = "{base_topic}/{camera_key}";

const SUPPORTED_TEMPLATE_FIELDS = new Set([
  "base_topic",
  "camera_key",
  "camera_name",
]);

export function normalizeBaseTopic(value) {
  return String(value ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

function sanitizeDynamicTopicValue(value) {
  return String(value ?? "")
    .trim()
    .replace(/[+#\u0000]/g, "-")
    .replace(/\//g, "-")
    .replace(/-{2,}/g, "-");
}

export function validatePublishTopic(topicValue) {
  const topic = String(topicValue ?? "").trim();

  if (!topic) throw new Error("MQTT topic cannot be empty");
  if (topic.includes("\u0000")) {
    throw new Error("MQTT topic cannot contain a null character");
  }
  if (topic.includes("+") || topic.includes("#")) {
    throw new Error("Publish topics cannot contain MQTT wildcards (+ or #)");
  }
  if (Buffer.byteLength(topic, "utf8") > 65535) {
    throw new Error("MQTT topic exceeds the protocol length limit");
  }

  return topic;
}

export function renderCameraTopic({
  baseTopic = DEFAULT_BASE_TOPIC,
  template = DEFAULT_CAMERA_TOPIC_TEMPLATE,
  cameraKey,
  cameraName,
  topicOverride = "",
}) {
  if (String(topicOverride ?? "").trim()) {
    return validatePublishTopic(topicOverride);
  }

  const normalizedBaseTopic = normalizeBaseTopic(baseTopic);
  if (!normalizedBaseTopic) throw new Error("MQTT base topic cannot be empty");
  if (!isValidCameraKey(cameraKey)) {
    throw new Error("Camera key must contain only lowercase letters, numbers, and hyphens");
  }

  const templateText = String(template ?? "").trim();
  if (!templateText) throw new Error("MQTT camera topic template cannot be empty");

  const discoveredFields = [...templateText.matchAll(/\{([^{}]+)\}/g)].map(
    (match) => match[1]
  );
  const unsupportedFields = discoveredFields.filter(
    (field) => !SUPPORTED_TEMPLATE_FIELDS.has(field)
  );

  if (unsupportedFields.length > 0) {
    throw new Error(
      `Unsupported MQTT topic field: {${unsupportedFields[0]}}`
    );
  }

  const rendered = templateText
    .replaceAll("{base_topic}", normalizedBaseTopic)
    .replaceAll("{camera_key}", cameraKey)
    .replaceAll("{camera_name}", sanitizeDynamicTopicValue(cameraName))
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");

  if (/\{[^{}]+\}/.test(rendered)) {
    throw new Error("MQTT topic template contains an unresolved field");
  }

  return validatePublishTopic(rendered);
}
