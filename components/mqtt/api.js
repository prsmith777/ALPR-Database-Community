export async function mqttRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });

  let result = null;
  try {
    result = await response.json();
  } catch {
    throw new Error(`MQTT request failed with HTTP ${response.status}`);
  }

  if (!response.ok || result?.success === false) {
    throw new Error(result?.error || `MQTT request failed with HTTP ${response.status}`);
  }

  return result?.data;
}

export function formatMqttDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}
