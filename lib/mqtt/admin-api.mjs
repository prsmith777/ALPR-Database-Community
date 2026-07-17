export function mqttAdminErrorStatus(error) {
  const message = String(error?.message ?? "");
  if (
    /cannot be empty|cannot exceed|must be|invalid|unsupported|wildcard|topic/i.test(
      message
    )
  ) {
    return 400;
  }
  if (error?.code === "23503") return 409;
  return 500;
}

export function mqttAdminErrorMessage(error, fallback) {
  const status = mqttAdminErrorStatus(error);
  if (status === 400 || status === 409) {
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
