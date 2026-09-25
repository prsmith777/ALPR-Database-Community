export const HELP_ROLE_LABELS = Object.freeze({
  administrator: "Administrator",
  operator: "Operator",
  viewer: "Viewer",
  auditor: "Auditor",
});

export const HELP_ALL_ROLES = Object.freeze(Object.keys(HELP_ROLE_LABELS));
const allRoles = () => [...HELP_ALL_ROLES];

export const HELP_MANUAL = Object.freeze({
  title: "ALPR Database Community User Guide",
  shortTitle: "User Guide",
  description: "A practical guide to using and safely administering the portable Community application.",
  manualVersion: "2.3",
  updatedAt: "September 25, 2026",
  coverageBaseline: "Published clean-history Community release with portable configuration and no private deployment controls.",
  filename: "ALPR-Database-Community-User-Guide.pdf",
  sections: [
    {
      id: "getting-started",
      title: "Getting started",
      summary: "Sign in, change a temporary password, and learn the page layout.",
      roles: allRoles(),
      keywords: ["login", "password", "navigation"],
      blocks: [{
        type: "steps",
        title: "First sign-in",
        items: [
          "After a guided fresh install, open the address printed by the installer, leave the username blank, and enter the administrator password you chose. The generated database password is not a login password.",
          "If prompted, replace the temporary password before using any other page.",
          "Use the desktop sidebar or mobile menu to open only the pages allowed by your role.",
        ],
      }, {
        type: "note",
        tone: "warning",
        title: "Keep credentials private",
        text: "Never include passwords, session cookies, API keys, broker credentials, database credentials, or real plate images in screenshots or issue reports.",
      }],
    },
    {
      id: "roles-and-access",
      title: "Users, roles, and access",
      summary: "Apply least privilege to administrators, operators, viewers, and auditors.",
      roles: allRoles(),
      keywords: ["roles", "users", "permissions"],
      blocks: [{
        type: "bullets",
        title: "Built-in roles",
        items: [
          "Administrator manages configuration, integrations, users, maintenance, and audit data.",
          "Operator reviews reads and manages known plates and tags without system administration access.",
          "Viewer has read-only plate access.",
          "Auditor has read-only plate access plus exports and audit visibility.",
        ],
      }],
    },
    {
      id: "dashboard",
      title: "Dashboard",
      summary: "Review recent activity by time window and camera.",
      roles: allRoles(),
      keywords: ["dashboard", "metrics", "camera"],
      blocks: [{
        type: "bullets",
        title: "Dashboard controls",
        items: [
          "Choose one or more cameras or leave the camera filter empty to include all cameras.",
          "Change the time window to update totals, charts, top plates, and tag distribution.",
          "Select a metric or chart segment to open the matching Recognition Feed results.",
        ],
      }],
    },
    {
      id: "recognition-feed",
      title: "Recognition Feed",
      summary: "Inspect accepted reads, images, direction, confidence, and review state.",
      roles: allRoles(),
      keywords: ["live feed", "recognition", "images"],
      blocks: [{
        type: "bullets",
        title: "Review reads",
        items: [
          "Filter by plate, camera, date, confidence, tags, or review status.",
          "Open an image to inspect the plate capture and any available local vehicle view.",
          "Operators and administrators can confirm a read or correct one read without losing evidence of the original OCR value.",
        ],
      }],
    },
    {
      id: "database-review",
      title: "Database review and corrections",
      summary: "Correct OCR safely while preserving audit evidence.",
      roles: allRoles(),
      keywords: ["correction", "review", "audit"],
      blocks: [{
        type: "steps",
        title: "Correct one read",
        items: [
          "Open the exact read from Recognition Feed or Database.",
          "Compare the image with the observed plate before entering a correction.",
          "Save the corrected value; the original observation and review history remain available.",
        ],
      }],
    },
    {
      id: "known-plates-and-tags",
      title: "Known plates, monitored plates, and tags",
      summary: "Name recurring vehicles and organize investigation context.",
      roles: allRoles(),
      keywords: ["known plates", "monitored", "tags"],
      blocks: [{
        type: "bullets",
        title: "Organize records",
        items: [
          "Known Plates can attach a display name and notes to a recurring effective plate.",
          "Monitored Plates replaces the separate Watchlist page and records reason and priority without deleting any read.",
          "Tags can be applied to vehicles or individual reads and used as filters.",
        ],
      }],
    },
    {
      id: "exports",
      title: "Exports",
      summary: "Create bounded CSV or JSON investigations.",
      roles: ["administrator", "auditor"],
      keywords: ["export", "csv", "json"],
      blocks: [{
        type: "steps",
        title: "Export the exact filtered investigation",
        items: [
          "Apply the required plate, camera, tag, review, and date filters.",
          "Preview the scope before creating an export.",
          "Store the downloaded file as sensitive data because it may contain real plates and timestamps.",
        ],
      }],
    },
    {
      id: "vehicle-search",
      title: "Vehicle image similarity search",
      summary: "Use local visual similarity as review evidence, not proof of identity.",
      roles: allRoles(),
      keywords: ["vehicle", "visual search", "find similar"],
      blocks: [{
        type: "bullets",
        title: "Safe visual search",
        items: [
          "Vehicle Search ranks locally stored visual evidence and does not contact an external recognition provider.",
          "Cosine similarity may rank candidates but never proves that two observations are the same vehicle.",
          "Primary Vehicle Search deliberately omits profile-agreement context so a current profile cannot bias visual review.",
        ],
      }],
    },
    {
      id: "notification-rules",
      title: "Notification rules",
      summary: "Configure explicit rules for MQTT, Pushover, email, and signed webhooks.",
      roles: ["administrator"],
      keywords: ["notifications", "pushover", "email", "webhook"],
      blocks: [{
        type: "bullets",
        title: "Guarded activation",
        items: [
          "Save a disabled draft first, verify its matching scope, and test the selected channel.",
          "Enable a rule only after recent real reads demonstrate that its conditions are correct.",
          "Webhook destinations block unsafe targets unless the administrator explicitly enables the required network policy.",
        ],
      }],
    },
    {
      id: "mqtt",
      title: "MQTT integration",
      summary: "Publish accepted reads to user-configured brokers and topics.",
      roles: ["administrator"],
      keywords: ["mqtt", "broker", "topic"],
      blocks: [{
        type: "steps",
        title: "Safely configure MQTT",
        items: [
          "Add a broker without copying credentials into logs or screenshots.",
          "Confirm the generated per-camera topic or supply an explicit fixed topic.",
          "Send a test message, then inspect Activity & Delivery before enabling rules.",
        ],
      }],
    },
    {
      id: "blue-iris",
      title: "Blue Iris integration",
      summary: "Configure your own host, cameras, alert body, and ordered crossings.",
      roles: ["administrator"],
      keywords: ["blue iris", "camera", "direction"],
      blocks: [{
        type: "bullets",
        title: "Portable camera setup",
        items: [
          "Set the Blue Iris host and credentials under Settings; the Community repository contains no fixed host or camera names.",
          "Send the ordered crossing in the trigger_type field and map both directions under Vehicle Setup.",
          "Test ingestion with a non-sensitive fixture before accepting live reads.",
        ],
      }],
    },
    {
      id: "storage-and-cleanup",
      title: "Storage health and cleanup",
      summary: "Monitor application storage, configure alerts, and use preview-first maintenance.",
      roles: ["administrator"],
      keywords: ["storage", "cleanup", "retention"],
      blocks: [{
        type: "bullets",
        title: "Read storage health safely",
        items: [
          "Storage Overview reports application-managed categories and database observations without warning about optional host-only measurements that are not configured.",
          "Monitoring & Alerts configures capacity thresholds and maintenance destinations; Email and Webhook must first be enabled and completed under Integrations.",
          "Advanced Maintenance contains dry-run retention planning, reconciliation, PostgreSQL observations, and guarded cleanup controls.",
          "Retention and record-limit values are planning inputs only; Community does not automatically delete plate reads or source images.",
          "Cleanup starts from an exact preview and can remove only reconciliation-confirmed derived orphans.",
          "Cleanup cannot delete original plate images, active references, or database records outside its confirmed candidate set.",
        ],
      }],
    },
    {
      id: "system-logs",
      title: "System logs and audit evidence",
      summary: "Investigate request IDs without exposing payloads or credentials.",
      roles: ["administrator", "auditor"],
      keywords: ["logs", "audit", "request id"],
      blocks: [{
        type: "bullets",
        title: "Investigate safely",
        items: [
          "Filter by request ID, read ID, level, source, and time window.",
          "Operational receipts intentionally omit passwords, API keys, image bytes, and request bodies.",
          "Treat exported incident evidence as sensitive and store it outside the source repository.",
        ],
      }],
    },
    {
      id: "deployment-and-security",
      title: "Deployment and security",
      summary: "Protect persistent data, apply exact-tag updates, and validate database imports.",
      roles: ["administrator"],
      keywords: ["docker", "postgresql", "backup", "security"],
      blocks: [{
        type: "bullets",
        title: "Operate the Community stack",
        items: [
          "Keep .env, auth, config, storage, logs, and database backups out of Git.",
          "For a new empty deployment, use the verified release bootstrap on Ubuntu Server 24.04 x86-64. It installs Git, Docker Engine, Compose, Buildx, and private Node.js 24, then checks out an exact stable tag and runs ./alpr-community install with health and empty-database checks.",
          "OpenVINO, ReID, and the pinned visual models are bundled in the application image rather than installed on the host. Fresh installs and updates run real CPU inference before accepting a newly built image.",
          "After one-time restricted host-agent setup, administrators can open Settings → Software Updates to check, install, validate, accept, or roll back an exact stable release. The ./alpr-community terminal menu remains available. Compatibility depends on the Linux guest and Docker Compose, not the hypervisor.",
          "Release discovery fetches canonical main explicitly, including for installations originally cloned with a tag-only Git refspec, and accepts only stable tags proven to belong to that branch.",
          "The host updater retains one compressed database/configuration rollback generation, never copies the image library, and never gives the application container Docker host access. Browser requests are limited to fixed operations and expire if the host agent does not claim them promptly.",
          "Rollback verifies its recorded backup, then recreates and restores the public schema inside one database transaction. Partitioned tables, standard schema access grants, extensions, application objects, and exact source row counts are restored together or not at all; rollback does not re-run migrations that could add seed data absent from the source.",
          "Use the guarded database-import helper to create a verified logical dump and restore it into a fresh PostgreSQL 17 target. Original ALPR Database installations must first reach the pinned v0.1.9 schema baseline.",
          "For an existing-system migration, use the bootstrap migration-preparation mode on a separate Ubuntu 24.04 target, then run ./alpr-community migrate wizard. It creates the PostgreSQL 17 target, performs the guarded database migration, copies and checksums local or SSH image storage, and starts an outbound-isolated target for browser review.",
          "The migration wizard resumes completed checkpoints and stores no passwords. It pauses for the operator to stop the source, review the target, accept it, and explicitly activate outbound networking; it never stops, switches, or deletes the retained source.",
          "Do not blindly copy auth, config, or .env secrets. Review integrations before migration activation because activation permits outbound notifications and Blue Iris access.",
          "Validate health, sign-in, ingestion, search, storage reconciliation, and image persistence after every deployment or restore.",
        ],
      }],
    },
    {
      id: "support-and-feedback",
      title: "Support, feedback, and security reports",
      summary: "Choose the correct public or private GitHub channel and protect sensitive ALPR data.",
      roles: allRoles(),
      keywords: ["support", "feedback", "bug", "feature", "discussion", "security"],
      blocks: [{
        type: "bullets",
        title: "Where to report",
        items: [
          "Use GitHub Discussions for setup questions, general feedback, and help from the Community.",
          "Use the structured GitHub bug form for a reproducible application problem and the feature form for a proposed improvement.",
          "Use GitHub private vulnerability reporting for a suspected security flaw. Never publish unpatched vulnerability details in an issue or discussion.",
        ],
      }, {
        type: "note",
        tone: "warning",
        title: "Public reports must be sanitized",
        text: "Issues and discussions are public. Remove credentials, real license plates, camera images, private addresses, database contents, and identifying metadata before posting.",
      }],
    },
    {
      id: "planned-features",
      title: "Planned features that are not available yet",
      summary: "Distinguish Community roadmap ideas from supported behavior.",
      roles: allRoles(),
      keywords: ["roadmap", "planned"],
      blocks: [{
        type: "bullets",
        title: "Outside the current Community boundary",
        items: [
          "Browser-managed software updates require the separate restricted host agent; native Windows Docker and appliance-specific update adapters remain planned rather than supported.",
          "Radar traffic correlation, AI assistant endpoints, and TPMS prototypes are not included.",
          "Advanced visual-identity conversion, cutover, and campaign controls require separate portability and privacy review.",
        ],
      }],
    },
  ],
});

export function manualSearchText(section) {
  const values = [section.title, section.summary, ...(section.keywords || [])];
  for (const block of section.blocks || []) {
    values.push(block.title, block.text, block.scenario, block.result);
    values.push(...(block.items || []), ...(block.steps || []));
  }
  return values.filter(Boolean).join(" ").toLowerCase();
}
