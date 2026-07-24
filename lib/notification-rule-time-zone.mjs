function validTimeZone(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "";
  }
}

export function preferredRuleTimeZone({ browserTimeZone, configuredTimeZone } = {}) {
  return validTimeZone(browserTimeZone)
    || validTimeZone(configuredTimeZone)
    || "America/Denver";
}

export function syncQuietHoursTimeZone({ quietHours, priorRuleTimeZone, nextRuleTimeZone } = {}) {
  const current = String(quietHours?.timeZone || "").trim();
  return {
    ...(quietHours || {}),
    timeZone: !current || current === priorRuleTimeZone ? nextRuleTimeZone : current,
  };
}
