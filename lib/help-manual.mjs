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
  description: "A practical guide to using, configuring, and safely administering the portable Community application.",
  manualVersion: "3.0",
  updatedAt: "September 25, 2026",
  coverageBaseline: "Published clean-history Community release with portable configuration and no private deployment controls.",
  filename: "ALPR-Database-Community-User-Guide.pdf",
  sections: [
    {
      id: "getting-started",
      title: "Getting started",
      summary: "Complete a first sign-in, separate the application password from the database password, and verify the empty installation.",
      roles: allRoles(),
      keywords: ["login", "password", "navigation", "first run"],
      blocks: [{
        type: "steps",
        title: "First sign-in",
        items: [
          "After a guided fresh install, open the address printed by the installer, leave the username blank, and enter the administrator password you chose. The generated database password is not a login password.",
          "If prompted, replace a temporary password before using any other page. Save the new application password in your password manager.",
          "Confirm that Dashboard, Recognition Feed, and Database open. A new installation should contain no sample plate reads or test images.",
          "Use the desktop sidebar or mobile menu to open only the pages allowed by your role.",
        ],
      }, {
        type: "note",
        tone: "warning",
        title: "Keep credentials and evidence private",
        text: "Never include passwords, session cookies, API keys, broker credentials, database credentials, real plate numbers, or camera images in screenshots, logs, issue reports, or Git commits.",
      }],
    },
    {
      id: "roles-and-access",
      title: "Users, roles, and access",
      summary: "Create named users, apply least privilege, reset passwords, and manage the ingestion API key.",
      roles: allRoles(),
      keywords: ["roles", "users", "permissions", "api key", "security"],
      settingsViews: ["/settings/security"],
      blocks: [{
        type: "bullets",
        title: "Built-in roles",
        items: [
          "Administrator manages configuration, integrations, users, maintenance, and audit data.",
          "Operator reviews reads and manages known plates and tags without system-administration access.",
          "Viewer has read-only plate access.",
          "Auditor has read-only plate access plus exports and audit visibility.",
        ],
      }, {
        type: "steps",
        title: "Create and maintain named users",
        items: [
          "Open Settings > Security. If the installation still uses the compatibility administrator, create the first named administrator with the current administrator password.",
          "Add each person separately, choose the lowest role that fits, and issue a unique temporary password of at least eight characters.",
          "The user changes that temporary password at first sign-in. An administrator can later reset it after confirming with the administrator's own password.",
          "Deleting a user requires the exact username and the administrator's password. Do not share one named administrator account among several people.",
        ],
      }, {
        type: "note",
        tone: "warning",
        title: "API-key lifecycle",
        text: "The API key authenticates ingestion clients such as Blue Iris. Regenerating it immediately invalidates the old key, so update every sender before expecting new reads. Do not use the API key as a browser login password.",
      }],
    },
    {
      id: "general-settings",
      title: "General settings",
      summary: "Set display time and planning thresholds without mistaking them for deletion policies.",
      roles: ["administrator"],
      keywords: ["record limit", "retention", "time format", "planning"],
      settingsViews: ["/settings/general"],
      blocks: [{
        type: "bullets",
        title: "What these settings do",
        items: [
          "Record-limit planning threshold is used by the read-only maintenance preview. It does not delete plate reads.",
          "Image-retention planning period is also a preview input. It does not delete source images.",
          "Time Format changes displayed local times between 12-hour and 24-hour presentation; stored timestamps remain unchanged.",
          "Save settings before leaving the page.",
        ],
      }],
    },
    {
      id: "database-settings",
      title: "Database settings",
      summary: "Understand when the database connection fields are usable and when to leave them alone.",
      roles: ["administrator"],
      keywords: ["database host", "database password", "postgresql", "connection"],
      settingsViews: ["/settings/database"],
      blocks: [{
        type: "bullets",
        title: "Connection fields",
        items: [
          "Database Host & Port, Database Name, and Database User identify the PostgreSQL service used by the application.",
          "Database Password is replacement-only. Leaving it blank preserves the saved password; entering a value replaces it.",
          "The standard Docker installation supplies these values. Change them only when deliberately moving to another PostgreSQL service or following the migration guide.",
          "An incorrect host, name, user, or password can prevent the application from starting. Create a verified backup before changing a working connection.",
        ],
      }],
    },
    {
      id: "plate-matching-settings",
      title: "Plate Matching settings",
      summary: "Tune fuzzy matching conservatively and test changes before using them in searches or rules.",
      roles: ["administrator"],
      keywords: ["fuzzy", "ocr groups", "transposition", "insert delete", "profile"],
      settingsViews: ["/settings/plate-matching"],
      blocks: [{
        type: "steps",
        title: "Tune and test a profile",
        items: [
          "Set Minimum characters for fuzzy matching high enough to avoid broad matches on short plates.",
          "Use comma-separated OCR-equivalent groups only for characters your cameras commonly confuse, such as 0 and O.",
          "For each profile, limit ordinary differences and OCR-equivalent differences. Enable added/missing characters or adjacent swaps only when needed.",
          "Use Test the profiles with a search value and a stored candidate. Confirm the result before saving production changes.",
          "Use Reset defaults only when you intend to discard the current tuning.",
        ],
      }],
    },
    {
      id: "review-corrections-settings",
      title: "Review & Corrections settings",
      summary: "Create narrowly scoped recurring OCR aliases without rewriting historical evidence.",
      roles: ["administrator"],
      keywords: ["alias", "recurring misread", "camera scope", "correction"],
      settingsViews: ["/settings/review-corrections"],
      blocks: [{
        type: "steps",
        title: "Create a recurring misread alias",
        items: [
          "Enter the value the camera reads in Camera reads and the intended plate in Resolve as.",
          "Use Camera scope when the OCR mistake belongs to one camera; leave it blank only when the alias is valid for every camera.",
          "Record a reason, save the alias, and review the Plate aliases list.",
          "Remove an alias that begins producing false matches. The original OCR observation and audit history remain available.",
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
          "Community does not expose a speed column because this edition has no radar detector input.",
        ],
      }],
    },
    {
      id: "recognition-feed",
      title: "Recognition Feed",
      summary: "Inspect accepted reads, images, direction, confidence, and review state.",
      roles: allRoles(),
      keywords: ["live feed", "recognition", "images", "direction review"],
      blocks: [{
        type: "bullets",
        title: "Review reads",
        items: [
          "Filter by plate, camera, date, confidence, tags, or review status.",
          "Open an image to inspect the plate capture and any available local vehicle view. A blank image area means no source image was supplied or the referenced file is unavailable.",
          "Operators and administrators can confirm a read or correct one read without losing evidence of the original OCR value.",
          "Use Review vehicle direction to label a clear vehicle capture as Front view or Rear view. Do not label an ambiguous, obstructed, or unsuitable nighttime image.",
        ],
      }],
    },
    {
      id: "database-review",
      title: "Database review and corrections",
      summary: "Correct OCR safely while preserving audit evidence.",
      roles: allRoles(),
      keywords: ["correction", "review", "audit", "database search"],
      blocks: [{
        type: "steps",
        title: "Correct one read",
        items: [
          "Open the exact read from Recognition Feed or Database.",
          "Compare the image with the observed plate before entering a correction.",
          "Save the corrected value; the original observation and review history remain available.",
          "Use a recurring alias only after the same camera-specific OCR mistake repeats and the mapping is unambiguous.",
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
          "Names, notes, reasons, and tags are sensitive local metadata; include them in backup and disclosure planning.",
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
      keywords: ["vehicle", "visual search", "find similar", "reid"],
      blocks: [{
        type: "bullets",
        title: "Safe visual search",
        items: [
          "Vehicle Search ranks locally stored visual evidence and does not contact an external recognition provider.",
          "Cosine similarity may rank candidates but never proves that two observations are the same vehicle.",
          "Primary Vehicle Search deliberately omits profile-agreement context so a current profile cannot bias visual review.",
          "OpenVINO, ReID code, and pinned models run inside the application image; they are not separately installed on the host.",
        ],
      }],
    },
    {
      id: "vehicle-setup",
      title: "Vehicle Setup and direction",
      summary: "Define per-camera semantic direction labels, optional Blue Iris crossings, and local ReID fallback.",
      roles: ["administrator"],
      keywords: ["front view", "rear view", "eastbound", "westbound", "motion_a>b", "direction confidence"],
      settingsViews: ["/settings/vehicle-intelligence"],
      blocks: [{
        type: "steps",
        title: "Configure a camera direction profile",
        items: [
          "First ingest at least one read from the camera. Cameras appear here only after they have plate-read history.",
          "Choose the camera. Front-view direction label means the travel direction represented when the vehicle's front is visible; Rear-view direction label means the direction represented when its rear is visible. Use site language such as Eastbound/Westbound or Entering/Exiting.",
          "Use different, non-empty front and rear labels. Set the minimum confidence between 50% and 95%.",
          "Enable Direction classification only after the labels are correct. The local ReID fallback needs at least three clear Front view and three clear Rear view training observations for that camera.",
          "If using Blue Iris crossings, enable Blue Iris zone-crossing direction and map an exact reverse pair such as MOTION_A>B and MOTION_B>A.",
          "Save the profile and verify a new live read. A mapped crossing can set direction immediately; otherwise eligible images may use the local ReID fallback.",
        ],
      }, {
        type: "note",
        tone: "warning",
        title: "Nighttime and ambiguous images fail closed",
        text: "Monochrome nighttime captures can show Unavailable nighttime, and weak evidence can remain Unknown or Pending. Do not force a label merely to remove a status.",
      }],
    },
    {
      id: "notification-rules",
      title: "Notification rules",
      summary: "Build explicit conditions and actions for MQTT, Pushover, email, and signed webhooks.",
      roles: ["administrator"],
      keywords: ["notifications", "rule", "condition", "action", "draft"],
      blocks: [{
        type: "steps",
        title: "Guarded activation",
        items: [
          "Configure and test the destination integration before building a rule.",
          "Create the rule conditions and at least one action, then save a disabled draft first.",
          "Use the rule preview against recent real reads and verify both matches and non-matches.",
          "Enable a rule only when its selected channels report ready. Review delivery activity after the next matching read.",
        ],
      }],
    },
    {
      id: "mqtt",
      title: "MQTT integration",
      summary: "Configure brokers, camera topics, payload behavior, tests, and delivery activity.",
      roles: ["administrator"],
      keywords: ["mqtt", "broker", "topic", "qos", "retain", "activity"],
      settingsViews: ["/settings/integrations/mqtt", "/settings/integrations/mqtt/cameras", "/settings/integrations/mqtt/activity"],
      blocks: [{
        type: "steps",
        title: "Safely configure MQTT",
        items: [
          "In Brokers, add a display name, host or IP, port, optional username/password, client ID, and TLS choice. Leave a replacement password blank when editing to preserve the saved password.",
          "In Cameras & Topics, set the base topic, camera topic template, local timezone, default QoS, and local time format. Retained messages are off by default and are not recommended for plate events.",
          "Enable the broker, the required cameras, and global MQTT publishing only after the topic preview is correct.",
          "In Test & Activity, select a broker and camera identity, queue a non-sensitive test, and confirm its delivery status before activating an MQTT notification action.",
        ],
      }],
    },
    {
      id: "pushover",
      title: "Pushover integration",
      summary: "Configure credentials and delivery defaults, review usage, and send a direct test.",
      roles: ["administrator"],
      keywords: ["pushover", "application token", "user key", "priority", "usage"],
      settingsViews: ["/settings/integrations/pushover", "/settings/integrations/pushover/defaults", "/settings/integrations/pushover/usage", "/settings/integrations/pushover/test"],
      blocks: [{
        type: "steps",
        title: "Configure and test Pushover",
        items: [
          "In Connection, enter the Pushover application token and user key, enable Pushover, and save. Blank credential fields preserve saved values; the clear checkboxes remove them.",
          "In Defaults, choose the title, priority from -2 through 2, and sound used when a rule does not override them.",
          "Review Usage before relying on high-volume rules.",
          "In Test, enter a non-sensitive sample plate and send a direct test. Tests bypass rules and do not create a plate read.",
        ],
      }],
    },
    {
      id: "email",
      title: "Email integration",
      summary: "Configure SMTP transport and sender identity, then verify a recipient with a direct test.",
      roles: ["administrator"],
      keywords: ["email", "smtp", "tls", "sender", "recipient"],
      settingsViews: ["/settings/integrations/email", "/settings/integrations/email/sender", "/settings/integrations/email/test"],
      blocks: [{
        type: "steps",
        title: "Configure and test email",
        items: [
          "In SMTP Connection, enter the host and port. Add a username and password when required; leave both blank only for a trusted relay.",
          "Use implicit TLS for services that require it, commonly on port 465. Keep Verify TLS certificate enabled unless a controlled local service has a documented exception.",
          "In Sender Identity, set the From address and From name, then save and enable email.",
          "In Test, enter a recipient and send a direct test. Tests bypass rules and do not create a plate read.",
        ],
      }],
    },
    {
      id: "webhook",
      title: "Webhook integration",
      summary: "Deliver HMAC-signed JSON while keeping private-network and HTTP exceptions explicit.",
      roles: ["administrator"],
      keywords: ["webhook", "hmac-sha256", "x-alpr-signature", "private network", "http"],
      settingsViews: ["/settings/integrations/webhook", "/settings/integrations/webhook/safety", "/settings/integrations/webhook/test"],
      blocks: [{
        type: "steps",
        title: "Configure and test a webhook",
        items: [
          "In Signing & Delivery, enter a signing secret and request timeout, enable webhooks, and save. The receiver verifies the raw request body using X-ALPR-Signature; each request also includes an event ID and idempotency key.",
          "Keep HTTPS required. Allow unencrypted HTTP only on a network you control.",
          "Allow private-network targets only when the destination must use 10.x, 172.16-31.x, or 192.168.x. Loopback and other special-use targets remain blocked.",
          "In Test, enter the exact destination URL and send a direct test before adding it to a notification rule.",
        ],
      }],
    },
    {
      id: "blue-iris",
      title: "Blue Iris integration",
      summary: "Configure read-only Blue Iris access, authenticated plate ingestion, image retrieval, and ordered zone crossings.",
      roles: ["administrator"],
      keywords: ["blue iris", "api/plate-reads", "x-api-key", "alert_jpeg", "trigger_type", "motion_a>b"],
      settingsViews: ["/settings/blue-iris"],
      blocks: [{
        type: "bullets",
        title: "Two credential directions",
        items: [
          "Settings > Blue Iris stores the Blue Iris host, username, and password that ALPR uses for read-only camera, alert, playback, and frame-retrieval requests.",
          "Settings > Security supplies the ALPR API key that Blue Iris uses when it posts a plate read to ALPR. Send it in x-api-key or Authorization: Bearer; never put it in a URL or query string.",
          "Changing one credential direction does not update the other. Regenerating the ALPR API key requires updating the Blue Iris action.",
        ],
      }, {
        type: "steps",
        title: "Configure the ALPR connection to Blue Iris",
        items: [
          "Open Settings > Blue Iris. Enter the Blue Iris hostname or IP and include :port when it is not port 80.",
          "Enter a Blue Iris user that can list cameras, search alerts, and retrieve playback frames. Set the request timeout from 2 through 30 seconds.",
          "Keep the timeline export profile between 0 and 3. Set the minimum overview export width and height; exports below that resolution fail closed instead of saving a low-resolution Vehicle View.",
          "Save, run the read-only connection test, select a camera and local plate-read time, search within the tolerance window, and optionally select the best vehicle frame. The test does not change Blue Iris recordings.",
        ],
      }, {
        type: "steps",
        title: "Create the Blue Iris plate-read action",
        items: [
          "In the Blue Iris camera alert actions, add an HTTP/HTTPS Web Request action that POSTs to http://ALPR_HOST:PORT/api/plate-reads. Blue Iris 5 and 6 place trigger and zone controls differently; version 6 moved more configuration under Zones.",
          "Add Content-Type: application/json and x-api-key: YOUR_ALPR_API_KEY as request headers.",
          "Use this JSON payload, substituting the address and key rather than changing field names: {\"ai_dump\":&JSON,\"Image\":\"&ALERT_JPEG\",\"camera\":\"&CAM\",\"ALERT_PATH\":\"&ALERT_PATH\",\"ALERT_CLIP\":\"&ALERT_CLIP\",\"timestamp\":\"&ALERT_TIME\",\"trigger_type\":\"&TYPE\"}",
          "Trigger one non-sensitive test event and verify a new read, camera name, timestamp, and image in Recognition Feed. An HTTP success alone is not sufficient verification.",
        ],
      }, {
        type: "bullets",
        title: "Ordered crossing and direction troubleshooting",
        items: [
          "Blue Iris uses A>B for an ordered zone crossing and A-B for a bidirectional zone relationship. ALPR direction mapping requires exact ordered values such as MOTION_A>B and the exact reverse MOTION_B>A.",
          "In Settings > Vehicle Setup, map each ordered trigger to the semantic label that applies at that camera. The two triggers must be an exact reverse pair.",
          "A Blue Iris 6 composite such as Motion_A>B,Zone A,Zone B is accepted when the valid ordered crossing is first. Conflicting crossing evidence fails closed.",
          "If no mapped crossing arrives, direction can remain Unknown or use the local ReID fallback after sufficient labeled Front view and Rear view examples exist.",
          "For Blue Iris action syntax and version-specific screen locations, consult the vendor manual at blueirissoftware.com/BlueIris.PDF.",
        ],
      }],
    },
    {
      id: "home-assistant",
      title: "Home Assistant integration",
      summary: "Use the iframe login-bypass whitelist only for explicitly trusted device addresses.",
      roles: ["administrator"],
      keywords: ["home assistant", "iframe", "whitelist", "bypass authentication", "ip address"],
      settingsViews: ["/settings/home-assistant"],
      blocks: [{
        type: "steps",
        title: "Configure iframe access",
        items: [
          "Open Settings > Home Assistant and leave Enable Whitelist off unless an iframe device must bypass the ALPR login page.",
          "When needed, enable the whitelist and add only the exact IPv4 or IPv6 address of each trusted Home Assistant device.",
          "Remove stale addresses when devices change. Do not whitelist a broad proxy, shared gateway, or untrusted client because any request seen from that address can bypass authentication.",
          "Test from the intended Home Assistant device and separately confirm that a non-whitelisted browser still receives the ALPR login page.",
        ],
      }],
    },
    {
      id: "storage-and-privacy",
      title: "Storage & Privacy",
      summary: "Read capacity, monitoring, cleanup, and outbound-data controls without confusing observations with deletion.",
      roles: ["administrator"],
      keywords: ["storage", "monitoring", "cleanup", "privacy", "reconciliation", "derived orphan"],
      settingsViews: ["/settings/data-privacy", "/settings/data-privacy/monitoring", "/settings/data-privacy/cleanup", "/settings/data-privacy/privacy"],
      blocks: [{
        type: "bullets",
        title: "Storage Overview",
        items: [
          "Storage Overview reports mounted capacity, application-managed categories, PostgreSQL size, recent ingestion, capture references, visual-index state, and capacity projections.",
          "Refresh and all measurements are read-only. The filesystem total can include unrelated data that shares the mount.",
        ],
      }, {
        type: "bullets",
        title: "Monitoring & Alerts",
        items: [
          "Set warning and critical percentages, check interval, stale interval, and alert cooldown.",
          "Email maintenance alerts require a ready Email integration. Webhook maintenance alerts require an enabled Webhook integration and signing secret.",
          "The maintenance webhook destination is write-only: enter it only to test or replace the saved value.",
        ],
      }, {
        type: "steps",
        title: "Advanced Maintenance and guarded cleanup",
        items: [
          "Review scheduled dry-run evidence and the bounded read-only storage reconciliation. Planning thresholds never delete plate reads or source images.",
          "Set the Derived orphan grace in days. Only generated files under derived/ that reconciliation still confirms as unreferenced can become candidates.",
          "For manual cleanup, create a fresh preview, review its exact candidate count and bytes, then type the displayed confirmation phrase. The candidate token prevents a stale or changed set from being used.",
          "Automatic derived-orphan cleanup is independently approved and off by default. A cleanup failure opens a circuit breaker; complete a fresh successful reconciliation before acknowledging the suspension.",
          "PostgreSQL maintenance is observability-only. The application does not run VACUUM, ANALYZE, backup, or restore from this page.",
        ],
      }, {
        type: "note",
        tone: "warning",
        title: "Cleanup boundary",
        text: "Guarded cleanup cannot delete original plate images, active references, database rows, or files outside its confirmed generated-derived candidate set.",
      }, {
        type: "bullets",
        title: "Privacy",
        items: [
          "Community does not send usage telemetry or upload plate images or annotations for model training.",
          "Pushover, MQTT, Email, signed webhooks, Blue Iris, and Home Assistant communicate only when you configure and use them.",
          "Software-update checks contact the Community release source only when the separate host update service is configured and an administrator checks for updates.",
        ],
      }],
    },
    {
      id: "release-and-updates",
      title: "Release information and Software Updates",
      summary: "Identify the installed build and use the guarded check, install, validate, accept, rollback, and cleanup workflow.",
      roles: ["administrator"],
      keywords: ["release", "software updates", "accept update", "rollback", "validation", "update service"],
      settingsViews: ["/settings/release", "/settings/software-updates"],
      blocks: [{
        type: "bullets",
        title: "Release page",
        items: [
          "Settings > Release shows the installed application version, source revision, release notes, and the public releases link.",
          "Use this page when reporting a problem so the exact installed build can be identified without exposing credentials.",
        ],
      }, {
        type: "steps",
        title: "Install and accept an update",
        items: [
          "The browser update page requires the separately installed restricted host update service. If it is unavailable, use the documented ./alpr-community terminal workflow.",
          "Select Check for updates. Install only the exact stable target shown by the page; installation creates a verified database/configuration backup before building and starting the tagged image.",
          "Wait for automated validation to pass. You may run validation again without accepting the release.",
          "Manually confirm sign-in, Dashboard and Database search, a test plate read, plate and vehicle images, and health after a restart. Accept update becomes available only after every checkbox is selected and no operation is running.",
          "Accepting removes the pending decision but retains one rollback generation until its deadline.",
        ],
      }, {
        type: "note",
        tone: "warning",
        title: "Rollback discards newer records",
        text: "Rollback restores the pre-update database, configuration, source release, and application image. Records written after the update snapshot are discarded. Use Rollback storage cleanup only after the host-enforced retention deadline.",
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
      title: "Deployment, migration, and security",
      summary: "Install host prerequisites, protect persistent data, apply exact-tag updates, and migrate supported databases.",
      roles: ["administrator"],
      keywords: ["docker", "compose", "node.js 24", "git", "postgresql 17", "backup", "migration", "security"],
      blocks: [{
        type: "bullets",
        title: "Supported host paths",
        items: [
          "For a new empty deployment, use the verified release bootstrap on Ubuntu Server 24.04 x86-64. It installs Git, Docker Engine, Compose, Buildx, private Node.js 24, and PostgreSQL 17 client utilities, then checks out an exact stable tag and runs ./alpr-community install with health and empty-database proof.",
          "Other x86-64 Linux distributions may work when they pass the compatibility preflight, but their package installation is manual. Native Windows Docker and ARM hosts are not currently supported installation targets.",
          "OpenVINO, ReID, and pinned visual models are bundled in the application image rather than installed on the host. Fresh installs and updates run real CPU inference before accepting a newly built image.",
          "Compatibility depends on the Linux guest and Docker Compose, not whether the VM host is Unraid, Proxmox, Hyper-V, VMware, or another hypervisor.",
        ],
      }, {
        type: "bullets",
        title: "Backups and exact releases",
        items: [
          "Keep .env, auth, config, storage, logs, and database backups out of Git.",
          "Release discovery fetches canonical main explicitly, including installations originally cloned with a tag-only Git refspec, and accepts only stable tags proven to belong to that branch.",
          "The host updater retains one compressed database/configuration rollback generation, never copies the image library, and never gives the application container Docker host access.",
          "Rollback verifies its recorded backup, recreates the public schema, and restores partitioned tables, access grants, extensions, objects, and exact source row counts inside one database transaction. It does not re-run migrations that could add absent seed data.",
        ],
      }, {
        type: "steps",
        title: "Migrate an existing ALPR Database installation",
        items: [
          "First update the original installation to the pinned v0.1.9 schema baseline. Earlier arbitrary schemas are not accepted for direct Community migration.",
          "On a separate Ubuntu 24.04 target, use bootstrap migration-preparation mode, then run ./alpr-community migrate wizard.",
          "The wizard creates the PostgreSQL 17 target, performs the guarded logical database migration, copies and checksums local or SSH image storage, and starts an outbound-isolated target for review.",
          "The wizard resumes completed checkpoints and stores no passwords. Stop the source only when prompted, review the isolated target, accept it, and explicitly activate outbound networking.",
          "Do not blindly copy auth, config, or .env secrets. Review integrations before activation because activation permits outbound notifications and Blue Iris access. The wizard never deletes the retained source.",
        ],
      }, {
        type: "note",
        tone: "warning",
        title: "Post-migration validation",
        text: "Validate health, named-user sign-in, ingestion, search, row counts, storage reconciliation, image display, image persistence after restart, and every enabled integration before retiring the source.",
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
          "Include the version from Settings > Release, the page and action involved, expected versus actual behavior, and sanitized reproduction steps.",
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
      pageBreakBefore: true,
      roles: allRoles(),
      keywords: ["roadmap", "planned"],
      blocks: [{
        type: "bullets",
        title: "Outside the current Community boundary",
        items: [
          "Browser-managed software updates require the separate restricted host agent; native Windows Docker and appliance-specific update adapters remain planned rather than supported.",
          "Radar traffic correlation, speed columns, AI assistant endpoints, and TPMS prototypes are not included.",
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
