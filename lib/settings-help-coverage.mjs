export const SETTINGS_HELP_COVERAGE = Object.freeze([
  {
    sectionId: "general-settings",
    routes: ["/settings/general"],
    requiredTerms: ["record-limit planning threshold", "does not delete plate reads", "time format"],
  },
  {
    sectionId: "database-settings",
    routes: ["/settings/database"],
    requiredTerms: ["database host & port", "managed in .env", "replacement-only", "verified backup"],
  },
  {
    sectionId: "plate-matching-settings",
    routes: ["/settings/plate-matching"],
    requiredTerms: ["minimum characters", "ocr-equivalent groups", "test the profiles"],
  },
  {
    sectionId: "review-corrections-settings",
    routes: ["/settings/review-corrections"],
    requiredTerms: ["camera reads", "resolve as", "camera scope"],
  },
  {
    sectionId: "vehicle-setup",
    routes: ["/settings/vehicle-intelligence"],
    requiredTerms: ["front-view direction label", "at least three", "motion_a>b", "exact reverse pair"],
  },
  {
    sectionId: "storage-and-privacy",
    routes: [
      "/settings/data-privacy",
      "/settings/data-privacy/monitoring",
      "/settings/data-privacy/cleanup",
      "/settings/data-privacy/privacy",
    ],
    requiredTerms: ["storage overview", "monitoring & alerts", "advanced maintenance", "derived orphan", "cannot delete original plate images", "usage telemetry"],
  },
  {
    sectionId: "release-and-updates",
    routes: ["/settings/release", "/settings/software-updates"],
    requiredTerms: ["check for updates", "automated validation", "accept update", "rollback discards newer records"],
  },
  {
    sectionId: "roles-and-access",
    routes: ["/settings/security"],
    requiredTerms: ["temporary password", "regenerating it immediately invalidates", "deleting a user"],
  },
  {
    sectionId: "mqtt",
    routes: [
      "/settings/integrations/mqtt",
      "/settings/integrations/mqtt/cameras",
      "/settings/integrations/mqtt/activity",
    ],
    requiredTerms: ["brokers", "cameras & topics", "test & activity", "retained messages"],
  },
  {
    sectionId: "pushover",
    routes: [
      "/settings/integrations/pushover",
      "/settings/integrations/pushover/defaults",
      "/settings/integrations/pushover/usage",
      "/settings/integrations/pushover/test",
    ],
    requiredTerms: ["application token", "user key", "priority from -2 through 2", "tests bypass rules"],
  },
  {
    sectionId: "email",
    routes: [
      "/settings/integrations/email",
      "/settings/integrations/email/sender",
      "/settings/integrations/email/test",
    ],
    requiredTerms: ["smtp connection", "implicit tls", "sender identity", "tests bypass rules"],
  },
  {
    sectionId: "webhook",
    routes: [
      "/settings/integrations/webhook",
      "/settings/integrations/webhook/safety",
      "/settings/integrations/webhook/test",
    ],
    requiredTerms: ["hmac-signed", "x-alpr-signature", "allow unencrypted http", "private-network targets"],
  },
  {
    sectionId: "blue-iris",
    routes: ["/settings/blue-iris"],
    requiredTerms: ["two credential directions", "managed in .env", "/api/plate-reads", "x-api-key", "&alert_jpeg", "trigger_type", "motion_a>b"],
  },
  {
    sectionId: "home-assistant",
    routes: ["/settings/home-assistant"],
    requiredTerms: ["iframe", "enable whitelist", "bypass authentication", "non-whitelisted browser"],
  },
]);

export const SETTINGS_HELP_ROUTES = Object.freeze(
  SETTINGS_HELP_COVERAGE.flatMap((entry) => entry.routes)
);
