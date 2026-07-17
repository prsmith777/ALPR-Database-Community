export function mqttAdminErrorStatus(error) {
  const message = String(error?.message ?? "");
  if (
    /cannot be empty|cannot exceed|must be|\brequire(?:s|d)?\b|invalid|unsupported|wildcard|topic/i.test(
      message
    )
  ) {
    return 400;
  }
  if (["23503", "23505"].includes(error?.code)) return 409;
  return 500;
}

export function mqttAdminErrorMessage(error, fallback) {
  const status = mqttAdminErrorStatus(error);
  if (status === 400) {
    return String(error?.message ?? fallback);
  }
  return fallback;
}

export async function readJsonObject(request) {
  const data = await request.json();
  if (!data || Array.isArray(data) || typeof data !== "object") {
    throw new Error("MQTT request body must be a JSON object");
  }
  return data;
}
