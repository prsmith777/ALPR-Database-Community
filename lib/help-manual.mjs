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
  description:
    "A practical guide to viewing plate activity, reviewing OCR results, managing known plates, exporting records, and safely administering your ALPR installation.",
  manualVersion: "1.3",
  updatedAt: "July 22, 2026",
  coverageBaseline: "Application 0.1.9, unified rules migration preview",
  filename: "ALPR-Database-Community-User-Guide.pdf",
  sections: [
    {
      id: "getting-started",
      title: "Getting started",
      summary: "Sign in safely, change a temporary password, and learn the basic page layout.",
      roles: allRoles(),
      keywords: ["login", "password", "sign in", "navigation", "first login"],
      blocks: [
        {
          type: "steps",
          title: "Sign in",
          items: [
            "Open the ALPR website and enter your username and password on the Sign In page.",
            "Use the eye button to reveal the password only when you are sure nobody else can see the screen.",
            "Select Sign In. If the password is incorrect, the password field clears automatically and receives focus so you can try again.",
            "If your account has a temporary password, follow the prompt to choose a new password. You will then return to Sign In and use the new password.",
          ],
        },
        {
          type: "bullets",
          title: "What you will see",
          items: [
            "Desktop: the icon bar on the left opens the pages your role can use. Hover over an icon to see its name.",
            "Phone or tablet: the most common pages appear in the bottom bar. Select More for the complete menu.",
            "Settings is available to every named user for personal account changes; administrative sections appear only when the account has the required permission.",
            "If a direct link opens the Forbidden page, the account is signed in but its role does not permit that operation.",
          ],
        },
        {
          type: "note",
          tone: "info",
          title: "Keep credentials private",
          text: "Do not paste passwords, session cookies, API credentials, broker passwords, or database credentials into chat, screenshots, issue reports, or exported notes.",
        },
      ],
    },
    {
      id: "roles-and-access",
      title: "Users, roles, and access",
      summary: "Choose the least-privilege role and understand which pages each role can use.",
      roles: allRoles(),
      keywords: ["administrator", "operator", "viewer", "auditor", "permission", "user"],
      blocks: [
        {
          type: "bullets",
          title: "Built-in roles",
          items: [
            "Administrator: full configuration, integrations, users, maintenance, audit, exports, and plate operations.",
            "Operator: view plate activity, review or correct reads, and manage known plates and tags. Operators cannot administer users, MQTT, notifications, exports, audit, or maintenance.",
            "Viewer: read-only access to plate pages. Viewer navigation intentionally omits mutation and administrative controls.",
            "Auditor: read-only plate pages plus database exports and System Logs/audit access. Auditors cannot change plates or configuration.",
          ],
        },
        {
          type: "example",
          title: "Example: choose a role for a new user",
          scenario: "A person needs to investigate plate activity and download records, but must not change labels, tags, users, or integrations.",
          steps: [
            "Choose Auditor because it grants plate reading, exports, and audit visibility.",
            "Do not choose Administrator merely to expose one missing page.",
            "After creating the account, sign in as that user on staging and verify both allowed and forbidden pages.",
          ],
          result: "The user can investigate and export without receiving mutation or system-management authority.",
        },
        {
          type: "note",
          tone: "warning",
          title: "Administrator safeguards",
          text: "The final active administrator cannot be disabled, demoted, or deleted. Administrative password resets and permanent deletion require the acting administrator's current password and are written to the audit history.",
        },
      ],
    },
    {
      id: "dashboard",
      title: "Dashboard",
      summary: "Use the overview cards and charts to understand recent activity.",
      roles: allRoles(),
      keywords: ["dashboard", "metrics", "charts", "camera", "time frame", "top plates"],
      blocks: [
        {
          type: "bullets",
          title: "Dashboard controls and metrics",
          items: [
            "Camera limits the dashboard to one configured camera; All cameras combines them.",
            "Time frame changes the period used by total reads, unique vehicles, new vehicles, time distribution, camera counts, and top plates.",
            "Select a time-distribution bar to open Recognition Feed filtered to that hour.",
            "Hover over a top plate to preview recent captures. Select its reads count to open all matching appearances.",
            "The header links open the community documentation, fork source, product roadmap, and this Help Center.",
          ],
        },
        {
          type: "note",
          tone: "info",
          title: "Empty dashboard",
          text: "Waiting for License Plate Data means the application is ready but no accepted reads match the selected camera and time frame. It is not, by itself, a database error.",
        },
      ],
    },
    {
      id: "recognition-feed",
      title: "Recognition Feed",
      summary: "Browse individual reads, filter activity, inspect images, and control live updates.",
      roles: allRoles(),
      keywords: ["live feed", "recognition feed", "filter", "sorting", "live updates", "camera", "confidence"],
      blocks: [
        {
          type: "steps",
          title: "Find a group of reads",
          items: [
            "Open Live Feed and expand Search options.",
            "Enter a complete or partial plate, then choose a Plate matching mode when approximate OCR matching is useful.",
            "Optionally narrow the results by tag, camera, date, or hour.",
            "Select a sortable column heading to switch between ascending and descending order.",
            "Keep Live updates enabled for monitoring. Disable it while reviewing a stable result set so new reads do not move the rows.",
          ],
        },
        {
          type: "bullets",
          title: "Row and image actions",
          items: [
            "Select a thumbnail to inspect the larger capture and read details.",
            "Use Add tag or Remove tag to change classification when your role permits tag management.",
            "Use Confirm detected plate, Correct this read, Reject, Reopen, or Reverse review only after inspecting the original image.",
            "Delete is destructive and appears only for accounts with plate deletion permission.",
          ],
        },
        {
          type: "note",
          tone: "warning",
          title: "Matching is a candidate finder",
          text: "Approximate plate matches are not proof that two sightings are the same vehicle. Confirm the image, camera, time, and original observed OCR before taking action.",
        },
      ],
    },
    {
      id: "plate-matching",
      title: "Plate matching profiles",
      summary: "Choose Off, Strict, Balanced, or Broad without hiding how approximate matching behaves.",
      roles: allRoles(),
      keywords: ["fuzzy", "strict", "balanced", "broad", "ocr", "matching", "search"],
      blocks: [
        {
          type: "bullets",
          title: "Profile guide",
          items: [
            "Off: normal exact or partial text search. MQTT identity rules remain exact.",
            "Strict: favors the lowest false-positive rate and only accepts narrowly defined OCR-equivalent differences.",
            "Balanced: handles common OCR confusion and at most one ordinary difference within configured limits. This is the best starting point for a suspected misread.",
            "Broad: allows a wider candidate set for poor captures. Review the images carefully because false positives increase.",
            "Settings > Plate Matching lets an administrator configure minimum length, OCR-equivalent groups, insertion/deletion behavior, adjacent transpositions, and limits, then test two values interactively.",
          ],
        },
        {
          type: "example",
          title: "Example: search for a likely OCR misread",
          scenario: "The image looks like ABC128, but a prior camera read may have stored ABC123.",
          steps: [
            "Search for ABC128 with Off first to find exact and ordinary partial matches.",
            "If the expected sighting is missing, choose Balanced and search again.",
            "Inspect every candidate's image and timestamp. Use Broad only if Balanced is still too narrow.",
            "If ABC123 is a repeated, confirmed misread, an administrator can create an explicit recurring alias after correction.",
          ],
          result: "The search broadens gradually while the final identity decision remains a human review.",
        },
      ],
    },
    {
      id: "reviews-and-aliases",
      title: "Reviewing, correcting, and recurring aliases",
      summary: "Correct effective identity without destroying what the camera originally observed.",
      roles: ["administrator", "operator"],
      keywords: ["confirm", "correct", "reject", "reverse", "batch", "alias", "observed plate", "history"],
      blocks: [
        {
          type: "paragraph",
          text: "Every read keeps an immutable observed plate from the camera. Reviews change the effective plate used by searches, known-plate data, tags, rules, notifications, and MQTT while preserving the original evidence and append-only history.",
        },
        {
          type: "example",
          title: "Example: correct one read without losing evidence",
          scenario: "The camera reported ABC123, but the image clearly shows ABC128.",
          steps: [
            "Open the capture from Recognition Feed and compare the image with the observed plate.",
            "Select Correct this read and enter ABC128.",
            "Add a concise reason such as Clear final digit in full image and optional notes.",
            "Leave batch correction off unless the preview shows that every selected match is the same mistake.",
            "Apply the correction and open review history to confirm that ABC123 remains the observed plate while ABC128 is effective.",
          ],
          result: "Existing evidence remains immutable, and downstream known-plate, tag, rule, notification, and MQTT behavior uses ABC128.",
        },
        {
          type: "example",
          title: "Example: create a camera-scoped recurring alias",
          scenario: "Driveway West repeatedly reads ABC128 as ABC123, while another camera may legitimately see ABC123.",
          steps: [
            "Correct a verified Driveway West read from ABC123 to ABC128.",
            "Choose Remember as recurring alias and scope the alias to Driveway West.",
            "Preview the source, target, and camera scope before saving.",
            "Open Settings > Review & Corrections to confirm the alias is enabled.",
            "If the rule later proves unsafe, disable it. Aliases are retained for audit and cannot be deleted.",
          ],
          result: "Future exact ABC123 observations from only Driveway West resolve to ABC128; the original observed value and alias application remain auditable.",
        },
        {
          type: "note",
          tone: "warning",
          title: "Batch correction requires preview",
          text: "Batch correction is administrator-only. Review the server-generated scope and count, and never use a broad search result as automatic identity proof. Reverse the latest review when an approved correction must be undone.",
        },
      ],
    },
    {
      id: "plate-database",
      title: "Plate Database",
      summary: "Search summarized plate identities, sort every supported field, and carry filters into exports.",
      roles: allRoles(),
      keywords: ["database", "search options", "name", "notes", "tag", "camera", "date", "hour", "sorting"],
      blocks: [
        {
          type: "steps",
          title: "Build a precise database view",
          items: [
            "Open Database and expand Search options.",
            "Search by plate, known name, or notes and choose the matching profile.",
            "Combine the search with tag, camera, date, and hour filters as needed.",
            "Choose a page size and select a column heading to sort by plate, occurrences, name, notes, first seen, last seen, or tags.",
            "Use Clear controls to remove the complete filter set before starting another investigation.",
          ],
        },
        {
          type: "bullets",
          title: "Important behavior",
          items: [
            "Plate Database summarizes effective plate identities; Recognition Feed shows individual read events.",
            "Blank optional values sort last in both directions so missing names or notes do not hide populated rows.",
            "View insights opens aggregate details for the selected plate.",
            "Export these results preserves the current filters, matching mode, and sorting on the Downloads page when your role permits exports.",
          ],
        },
      ],
    },
    {
      id: "known-plates-tags-watchlist",
      title: "Known Plates, tags, and watchlist",
      summary: "Attach human context to plate identities and maintain classifications safely.",
      roles: ["administrator", "operator", "viewer", "auditor"],
      keywords: ["known plates", "tags", "watchlist", "flagged", "name", "notes"],
      blocks: [
        {
          type: "bullets",
          title: "Known Plates",
          items: [
            "Known Plates can store a name and notes for a plate identity and display its tags.",
            "Select any supported column heading to sort. Sorting is stable, numeric-aware, case-insensitive, and keeps blank optional values last.",
            "Administrators and Operators can edit known-plate details and tags. Viewers and Auditors can read them without mutation controls.",
          ],
        },
        {
          type: "bullets",
          title: "Tags and watchlist",
          items: [
            "Use tags for reusable classifications such as family, delivery, service, or vehicle color. A tag can appear in search and MQTT matching.",
            "Use the watchlist/flagged state for plates that require focused review; do not use it as a substitute for notes explaining why.",
            "Before removing a tag, consider how it affects saved searches, MQTT rules, and operational habits.",
          ],
        },
      ],
    },
    {
      id: "push-notifications",
      title: "Push notifications",
      summary: "Configure the current per-plate Pushover behavior and understand what is not yet available.",
      roles: ["administrator"],
      keywords: ["notification", "pushover", "priority", "test", "alert"],
      blocks: [
        {
          type: "steps",
          title: "Add and test a plate notification",
          items: [
            "Configure the Pushover application and user credentials in Settings before testing. Never include those credentials in screenshots or support messages.",
            "Review Monthly message allowance in Settings > Push Notifications. It shows messages sent, remaining, the current account-wide limit, and the next reset reported by Pushover. Select Refresh usage after changing the application token or sending a test.",
            "Open Notifications and select Add Push Notification.",
            "Enter the exact plate number, then choose its priority and whether it is active.",
            "Use Send test notification and confirm the message arrives at the intended destination.",
            "Disable the row to pause delivery without removing it, or Remove only when the plate should no longer be configured.",
            "Review Unified rules migration preview to see how current Pushover and MQTT rules translate into the shared model. The preview performs no writes and does not change delivery.",
          ],
        },
        {
          type: "note",
          tone: "warning",
          title: "Advanced notification rules are still inactive",
          text: "The current page provides exact per-plate Pushover alerts plus a read-only migration preview. Previewed shared rules remain disabled; count-within-period, schedules, nested-condition editing, rarity, cooldowns, and shared multi-channel delivery are not active yet.",
        },
      ],
    },
    {
      id: "mqtt",
      title: "MQTT integration",
      summary: "Connect brokers, map cameras, create durable rules, and test without causing unintended automation.",
      roles: ["administrator"],
      keywords: ["mqtt", "broker", "rule", "topic", "camera", "outbox", "test"],
      blocks: [
        {
          type: "steps",
          title: "Safely configure MQTT",
          items: [
            "Open MQTT and add the broker connection first. Use a dedicated, least-privilege broker account when possible.",
            "Test the broker connection before creating a rule. A successful test proves connectivity, not that a rule is correct.",
            "Review detected camera mappings and the per-camera topic before enabling automation.",
            "Create a disabled rule, choose its broker, match type, value, cameras, destination mode, message, and plate matching profile.",
            "Review the rule summary, then enable it during a supervised test window and check MQTT activity for delivery or retry status.",
          ],
        },
        {
          type: "example",
          title: "Example: publish a known delivery tag",
          scenario: "Home automation should receive accepted reads tagged Delivery from the driveway camera.",
          steps: [
            "Confirm the Delivery tag exists and is assigned consistently.",
            "Create an MQTT rule with match type Tag and value Delivery.",
            "Select only the driveway camera and the intended broker.",
            "Choose the exact fixed topic or verify the per-camera destination preview.",
            "Leave plate matching Off because tag matching does not need approximate plate identity.",
            "Save disabled, review it, then enable and observe one controlled test read.",
          ],
          result: "Only accepted driveway reads carrying the Delivery tag enter the durable MQTT delivery flow.",
        },
        {
          type: "note",
          tone: "warning",
          title: "Avoid automation loops",
          text: "Do not publish to a topic that another integration converts back into the same ALPR input. Keep test topics separate from production automation and verify retained-message behavior on the broker.",
        },
      ],
    },
    {
      id: "exports",
      title: "Downloads and exports",
      summary: "Download bounded CSV or JSON results using the same filters as Plate Database.",
      roles: ["administrator", "auditor"],
      keywords: ["download", "export", "csv", "json", "filter", "spreadsheet"],
      blocks: [
        {
          type: "example",
          title: "Example: export the exact filtered investigation",
          scenario: "You need all Balanced matches for ABC128 from Driveway West during the previous week, sorted newest first.",
          steps: [
            "Build the view in Plate Database: search ABC128, choose Balanced, select Driveway West, set the date range, and sort Last seen descending.",
            "Select Export these results. Downloads opens with the same search, matching mode, camera, dates, and sorting.",
            "Confirm every filter before downloading.",
            "Choose CSV for spreadsheet analysis or JSON for structured processing.",
          ],
          result: "The export contains up to 50,000 matching database records and reports when the result was truncated.",
        },
        {
          type: "bullets",
          title: "Export safety",
          items: [
            "CSV fields are escaped and spreadsheet-formula prefixes in user-controlled text are neutralized.",
            "Exports contain database text and timestamps, not a ZIP of capture images.",
            "Treat exported plate activity as sensitive data. Store it only where authorized and remove copies when they are no longer needed.",
          ],
        },
      ],
    },
    {
      id: "settings-audit-privacy",
      title: "Settings, users, audit, and privacy",
      summary: "Understand personal settings, administrative controls, audit history, and local-only privacy behavior.",
      roles: allRoles(),
      keywords: ["settings", "user management", "audit", "logs", "privacy", "retention", "password"],
      blocks: [
        {
          type: "bullets",
          title: "Settings and administration",
          items: [
            "Every named user can change their own password from personal settings.",
            "Administrators can manage users, system settings, integrations, plate matching profiles, and recurring aliases when the related permission is present.",
            "System Logs is available to Administrators and Auditors and includes durable security/audit events in addition to application logs.",
            "Data & Privacy is local status and configuration. Upstream telemetry, AI-training uploads, and remote update polling have been removed from this fork.",
          ],
        },
        {
          type: "note",
          tone: "info",
          title: "Audit history is intentionally durable",
          text: "Security, user-management, and review events are retained to explain who changed what and when. Deleting a user scrubs the login identity while retaining an audit tombstone rather than erasing history.",
        },
      ],
    },
    {
      id: "maintenance-updates",
      title: "Maintenance, backups, and updates",
      summary: "Use the established deployment process without exposing unrestricted host control inside the website.",
      roles: ["administrator"],
      keywords: ["maintenance", "backup", "update", "migration", "restore", "health", "rollback"],
      blocks: [
        {
          type: "bullets",
          title: "Safe release process",
          items: [
            "Changes are tested on a feature branch, validated by tests/typecheck/lint/build/security checks, and deployed to isolated staging first.",
            "Production deployment requires explicit approval, a verified PostgreSQL backup, an exact commit/image, one migration run, app-only restart when possible, health checks, and bounded log review.",
            "Application rollback returns to the recorded previous image. A runtime rollback does not automatically reverse database migrations.",
            "The website does not provide an arbitrary SQL shell, host shell, or unrestricted Docker update button.",
          ],
        },
        {
          type: "note",
          tone: "warning",
          title: "Legacy migration pages",
          text: "Backfill, JPEG migration, and Update pages are specialized maintenance tools, not routine navigation. Use them only with a current backup and a release-specific procedure.",
        },
      ],
    },
    {
      id: "troubleshooting",
      title: "Troubleshooting",
      summary: "Collect useful evidence without exposing credentials or changing data unnecessarily.",
      roles: allRoles(),
      keywords: ["troubleshooting", "error", "health", "support", "browser", "logs"],
      blocks: [
        {
          type: "steps",
          title: "When a page does not behave as expected",
          items: [
            "Confirm the signed-in username and role, then decide whether the behavior is a permission boundary or an application failure.",
            "Reload once and reproduce the smallest failing action. Record the page, time, selected filters, and exact visible error.",
            "Check the health endpoint or ask an Administrator to review System Logs and the bounded container logs for the same time.",
            "Capture a screenshot only after checking that it contains no password, session, API key, broker secret, private plate image, or unnecessary personal data.",
            "Do not refresh datasets, prune Docker, edit database rows, rerun migrations, or redeploy repeatedly merely to see whether the problem disappears.",
          ],
        },
        {
          type: "bullets",
          title: "Useful problem report",
          items: [
            "Application release or commit, browser/device, signed-in role, page, local timestamp, expected result, actual result, and reproduction steps.",
            "Whether the failure affects one account, one camera, one plate, or all activity.",
            "Whether a recent configuration, migration, or deployment preceded the problem.",
          ],
        },
      ],
    },
    {
      id: "visual-search",
      title: "Visual vehicle search",
      summary: "Compare local derived vehicle crops while keeping original captures unchanged.",
      roles: allRoles(),
      keywords: ["visual search", "vehicle image similarity search", "vehicle crop", "vehicle reid", "openvino", "duplicate", "camera filter"],
      blocks: [
        {
          type: "steps",
          title: "Find captures that look similar",
          items: [
            "Open a capture from Recognition Feed or Plate Database, then choose Find similar vehicle. You can also choose a recent indexed capture or upload a JPEG, PNG, or WebP vehicle image up to 5 MB in Visual Search.",
            "Uploaded queries are validated, decoded, and compared transiently. They are not stored as plate reads or written to the image library.",
            "Optionally narrow results by one or more cameras and a date range, then apply the filters.",
            "Review Vehicle ReID candidates visually. The learned image-embedding score is independent of plate text; the displayed plate is only a link to supporting capture history.",
            "Use Plate details to inspect the candidate's exact plate history and full capture context.",
          ],
        },
        {
          type: "bullets",
          title: "Index and score behavior",
          items: [
            "A resumable background worker indexes the newest unindexed captures automatically without making ingestion wait. Administrators can select a gentle, balanced, or fast pace, pause or resume the worker, and run one batch immediately.",
            "Automatic indexing pauses before a batch when free storage or system load crosses its configured safety threshold, then retries after the system recovers.",
            "OpenVINO scans the complete capture first, detects and tightly crops the vehicle, then vehicle-reid-0001 stores a normalized 512-value descriptor. A SHA-256 source hash separately identifies byte-for-byte duplicate captures.",
            "Automatic vehicle detection reports success and fallback counts per camera. It recommends review only after a meaningful sample shows recurring detector misses.",
            "Advanced camera fallback settings remain collapsed during normal use. Full image is the default; plate-centered adaptive or custom framing is used only when the detector cannot isolate a vehicle.",
            "Saving a fallback profile creates a new profile revision and reindexes only that camera's next 20 captures. Original capture images are never changed.",
            "Plate values never affect result inclusion, score, order, or labels. They are displayed only so a person can inspect the candidate's plate history.",
            "Search compares cosine similarity across at most 5,000 recent filtered indexed captures. Percentages rank candidates; only Exact duplicate is an identity claim.",
          ],
        },
        {
          type: "note",
          tone: "warning",
          title: "Visual similarity is not identity",
          text: "Two similar-looking vehicles may be different, and one vehicle may look different across angle, light, weather, or camera. Confirm the original images and surrounding evidence.",
        },
      ],
    },
    {
      id: "planned-features",
      title: "Planned features that are not available yet",
      summary: "Avoid confusing roadmap ideas with current production behavior.",
      roles: allRoles(),
      keywords: ["roadmap", "planned", "vehicle ai", "image search", "overlay", "advanced notifications", "storage"],
      blocks: [
        {
          type: "bullets",
          title: "Planned, not current",
          items: [
            "Unified notification rules with count/time windows, schedules, nested conditions, rarity, watchlist and fuzzy conditions, cooldowns, retries, and multi-channel actions.",
            "Vehicle make, model, color, body type, year, and jurisdiction enrichment with confidence and model/provider provenance.",
            "Domain-calibrated Vehicle ReID thresholds and optional make, model, color, body type, year, and jurisdiction filters.",
            "User-facing disk/database capacity forecasts and safe background maintenance/backup verification jobs.",
            "Configurable image overlays rendered non-destructively at view or export time.",
            "Background capture-image ZIP exports and richer read-only release/update visibility.",
          ],
        },
        {
          type: "note",
          tone: "info",
          title: "Roadmap status",
          text: "A roadmap entry explains intended architecture; it does not mean the feature is installed. This section will shrink as features pass staging acceptance and reach production.",
        },
      ],
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
