# Home Assistant displays

Open **Settings > Home Assistant** as an ALPR administrator. Enter a display name,
the exact Home Assistant origin (scheme, hostname and optional port), the camera
to expose or **All cameras**, and an expiration of 1–90 days. Create the display
and copy the link immediately into a Home Assistant **Webpage** card.

The link credential is shown once. It is stored as a SHA-256 hash in ALPR. The
secret is in the link's URL fragment, which browsers do not send in HTTP request
URLs or referrers. The display captures it in tab-scoped session storage and
removes it from its address. Do not share the link or publish it in diagnostics.
Create a new grant if it is lost. Administrators can revoke each grant separately.

The display contains up to 25 recent plate reads from the last 24 hours, with
plate/camera/time/direction and an available vehicle or plate image. It refreshes
every 15 seconds while visible. No record editing, settings, application API
access or administrative session is granted. All data and image requests check
the credential, camera scope, expiration and revocation, and use `no-store`.
Revocation prevents subsequent requests; the panel clears on its next refresh.
Previously viewed or copied information cannot be recalled.

Only the specified Home Assistant origin can frame the display. The rest of ALPR
continues to block framing and require ordinary session authentication. The
display's credential never substitutes for a session or the ingestion API key.
It works without third-party cookies. It does not trust client IPs, forwarded
headers, the referrer, or possession of a Home Assistant session as authentication.

If Home Assistant uses HTTPS, serve ALPR through HTTPS too; browsers block an
HTTP iframe inside an HTTPS page. Local HTTP can be used when both applications
are served over HTTP. The configured origin must exactly match the browser's
Home Assistant address, including a non-default port. Use separate grants for
different origins or devices so each can be revoked independently.

The legacy **Enable Whitelist** and IP login-bypass controls are retired. Old
configuration values are retained for compatibility but grant no access. The
obsolete verifier endpoint returns HTTP 410 to authenticated callers.

From v0.1.61, an authenticated display image request with an out-of-range image
ID returns HTTP 404 without querying images. Missing images, reads outside the
camera scope, and reads older than 24 hours also return 404. Missing, expired,
revoked or invalid credentials still return 401. An unavailable image does not
prevent the display from listing the read or refreshing other images.

## Verification

`test/home-assistant-display.test.mjs` checks credential isolation and policy
validation. The PostgreSQL upgrade matrix covers camera scope, expiration and
revocation. `scripts/test-community-bugfixes-local.mjs PG_BIN --browser` additionally
checks the production app in a real browser, including an approved and a blocked
iframe origin, images, revocation, and administrator create/revoke actions. Set
`ALPR_TEST_PLAYWRIGHT_MODULE` to a local `playwright-core/index.mjs` and
`ALPR_TEST_BROWSER` to the browser executable. All records and credentials used by
these fixtures are synthetic, and the local runner creates a separate cluster.
