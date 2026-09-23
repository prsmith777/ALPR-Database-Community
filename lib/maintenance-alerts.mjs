import { createHash } from "node:crypto";

const SEVERITY_RANK = Object.freeze({ ok: 0, warning: 1, critical: 2 });

export function maintenanceAlertFingerprint(details = {}) {
  return createHash("sha256").update(JSON.stringify(details)).digest("hex");
}

export function decideMaintenanceAlert({ previous = null, severity, now = new Date(), cooldownSeconds = 21_600 } = {}) {
  if (!Object.hasOwn(SEVERITY_RANK, severity)) throw new Error("Maintenance alert severity is invalid");
  const observedAt = new Date(now);
  if (severity === "ok") {
    const resolved = Boolean(previous && previous.severity !== "ok");
    return { notify: resolved, resolved, reason: resolved ? "recovered" : "healthy" };
  }
  if (!previous) {
    return { notify: true, resolved: false, reason: "new" };
  }
  if (
    (severity === "critical" && previous.severity !== "critical") ||
    (previous.severity !== "ok" && SEVERITY_RANK[severity] > SEVERITY_RANK[previous.severity])
  ) {
    return { notify: true, resolved: false, reason: "escalated" };
  }
  const nextEligible = previous.next_eligible_at || previous.nextEligibleAt;
  const lastNotified = previous.last_notified_at || previous.lastNotifiedAt;
  const eligibleAt = nextEligible
    ? new Date(nextEligible)
    : lastNotified
      ? new Date(new Date(lastNotified).getTime() + Math.max(300, Number(cooldownSeconds) || 21_600) * 1000)
      : null;
  // A warning that briefly recovers and then returns is the same noisy
  // condition for cooldown purposes. Critical observations still bypass this
  // branch through the escalation check above.
  if (previous.severity === "ok" || previous.resolved_at || previous.resolvedAt) {
    return {
      notify: !eligibleAt || eligibleAt <= observedAt,
      resolved: false,
      reason: !eligibleAt || eligibleAt <= observedAt ? "new" : "rate-limited",
    };
  }
  return {
    notify: !eligibleAt || eligibleAt <= observedAt,
    resolved: false,
    reason: !eligibleAt || eligibleAt <= observedAt ? "cooldown-expired" : "rate-limited",
  };
}

export function buildMaintenanceAlertPayload({ eventKey, severity, message, details = {}, observedAt = new Date() } = {}) {
  if (!eventKey || !message) throw new Error("Maintenance alert event key and message are required");
  const timestamp = new Date(observedAt).toISOString();
  return {
    eventKey: String(eventKey).slice(0, 255),
    severity,
    title: `ALPR maintenance ${severity}`,
    message: String(message).slice(0, 4000),
    timestamp,
    details,
  };
}

export const maintenanceAlertInternals = Object.freeze({ SEVERITY_RANK });
