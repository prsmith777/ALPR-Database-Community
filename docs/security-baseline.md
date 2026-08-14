# Security baseline

## Authentication boundaries

The integration endpoints `/api/plate-reads`, `/api/plates`, and any paths
nested beneath them require an API key. Send the key in one of these headers:

```http
x-api-key: YOUR_API_KEY
Authorization: Bearer YOUR_API_KEY
```

API keys in URL query parameters are rejected, including `?api_key=...`.
Keeping credentials out of URLs prevents them from being copied into browser
history, proxy logs, analytics, and referrer data.

All other protected application APIs use the browser's `session` cookie. They
do not accept the integration API key as a substitute. Missing or invalid
sessions receive a JSON `401`; a temporary session-verification failure
receives a JSON `503`. API clients are never redirected to an HTML login page.

The narrowly scoped public endpoints are the health check and the internal
key/session verifier endpoints required by middleware. The update-status
endpoint `/api/check-update` remains public where required by the current
application update flow. The `/update` page and its database/filesystem
mutation actions require a valid browser session. Static framework and
application assets required by login and update pages remain public.

## Fail-closed verification

Authentication succeeds only when a verifier returns HTTP 200 with the exact
JSON shape `{ "valid": true }`. HTTP 200 with `{ "valid": false }` and HTTP
4xx responses are authentication failures. Timeouts, network errors, HTTP 5xx
responses, malformed JSON, a missing `valid` field, and non-boolean `valid`
values are temporary authentication-service failures and never grant access.

Protected browser pages redirect unauthenticated users to `/login`. A valid
session visiting `/login` is redirected to `/`. Invalid and expired sessions
fail closed and clear the session cookie. Middleware does not authenticate by
client IP, does not trust `X-Forwarded-For`, and does not call the legacy
whitelist verifier.

API-key comparison uses `crypto.timingSafeEqual` after checking byte lengths.
Unequal-length credentials are rejected without calling `timingSafeEqual`.

## Session cookie policy

Session creation uses these attributes:

- `HttpOnly`
- `SameSite=Lax`
- `Path=/`
- `Max-Age=86400`

The cookie is non-Secure by default for direct-LAN HTTP Docker deployments.
Set the following environment variable when the application is served over
HTTPS:

```text
SESSION_COOKIE_SECURE=true
```

Only the exact lowercase value `true` enables `Secure`. The value `false`, an
unset value, and every other value keep the cookie non-Secure. The application
does not infer cookie security from `X-Forwarded-Proto`, the hostname, the
request URL, or any other client-controlled header. Cookie deletion uses the
same security, SameSite, and path attributes plus `Max-Age=0` and an epoch
expiration date.

## Logging and error disclosure

Authentication and plate-read processing log only generic operational events.
Logs must not include API keys, bearer tokens, authorization headers, session
IDs, authentication-file contents or paths, request query strings, plate-read
payloads, AI dumps, image contents, internal filesystem paths, raw exceptions,
or stack traces. Client errors are generic and do not include exception
messages or internal paths.

Integration arrivals emit safe request metadata before authentication so an
authentication failure remains observable without reading or retaining the
body. Blue Iris may declare a JSON alert body as `text/plain`; integration
routes record that declaration for diagnostics but determine validity by
parsing the size-limited body as a JSON object.

Authenticated integration requests also create short-lived ingress receipts
containing only bounded request-shape, correlation, trigger-type, status, and
count metadata. Receipts may record recognized field names, sizes, and a body
digest, but never store raw bodies, plate values, AI dumps, images, or Blue Iris
paths. Rejected authentication attempts create metadata-only receipts without
reading the body. Age and row-count policy identify cleanup candidates, but
ingress never deletes evidence on the request path and no cleanup schedule is
enabled.

Receipt schema v2 may record the names and distinct state/value count of supported
trigger aliases, whether those aliases conflict, and the numeric IDs of
existing reads targeted by a duplicate submission. It does not retain
alternate alias values or duplicate plate values. Existing schema-v1 receipts
remain readable, and the additive columns do not broaden cleanup authority or
change the age and row-count retention limits.

The protected System Logs action re-sanitizes parsed JSON before returning a
bounded page to an Administrator or Auditor. Filtering occurs on the server and
may use safe component, camera, request-ID, read-ID, level, date, and outcome
metadata. The browser never receives the entire active file in one response,
and expanding a row does not bypass credential, plate, payload, image, or path
redaction.

New accepted reads may also append a durable per-read pipeline timeline. Its
detail object uses an explicit allowlist of bounded booleans, counts, statuses,
direction labels, algorithm identifiers, and error codes. It never stores plate
text, request bodies, images, AI dumps, paths, alternate trigger values,
credentials, remote responses, or raw exceptions. Timeline writes are
best-effort after the read transaction commits, so an observability failure
cannot reverse an accepted read or cause a duplicate client retry.

An exact late duplicate may reconcile only against the existing event-identity
target while holding that read's database row lock. Reconciliation is fill-only:
an established image pair, Blue Iris alert pointer, direction bundle, or
recognition field is never overwritten, and a partially established grouped
pointer or direction bundle accepts additions only when every established value
matches the incoming evidence. Conflicting evidence is discarded with the
duplicate rather than retained as an alternate value.

Vehicle View work may be queued by reconciliation only when the target has an
attached source image and ready direction, has never been claimed or attempted,
has no completed vehicle image or backfill owner, and is either unset or in a
specific terminal missing-evidence state. A newly inserted primary-direction
observation may prepare its deterministic direction-notification event once.
General accepted-read MQTT, unified notifications, and legacy Pushover are not
replayed for duplicates. The database update, optional direction observation,
and any permitted outbox handoff share the ingestion transaction; a failure
rolls them back and removes a newly saved image.

The timeline query uses the same Administrator/Auditor permission as System
Logs, is parameterized by one positive read ID, and returns at most 100 events.
The event table has no update or delete application operation. Its rows use a
foreign key with `ON DELETE CASCADE`, so deleting a parent read through the
existing authorized retention or cleanup lifecycle removes only that read's
timeline; the timeline adds no cleanup authority or independent retention job.
Deleting an expired ingress receipt merely clears the optional receipt link.

The protected ingress-receipt explorer uses the same Administrator/Auditor
permission and returns only a bounded database page. Its filters are
parameterized, and its detail view exposes only the metadata-only receipt
fields described above. Links may correlate a request or produced read with
the protected operational-log view and may open the exact produced read in the
Recognition Feed; they do not add raw request values to either URL.

The protected Retention & incidents view exposes count, age, and size health to
Administrators and Auditors. Only an Administrator with `maintenance.manage`
may create an incident package or a retention preview. An incident scope is one
bounded request ID, positive read ID, or time window no longer than seven days.
Creation snapshots matching sanitized operational entries from retained files,
metadata-only receipts, allowlisted read-timeline events, and matching hot and
archived audit rows into an append-only, byte-bounded JSON object with a SHA-256
digest. Matching live receipts and hot audit events are protected until the
scope expires; the immutable package itself is not deleted at expiry.

Retention execution is hard-disabled on schedules. A preview stores only a
SHA-256 hash of its random one-time token, is bound to the creating actor, lists
exact candidate IDs, and expires after 15 minutes. Execution requires the exact
`ARCHIVE LOG EVIDENCE` phrase, revalidates the candidate set, and row-locks that
set in one transaction. Old audit events are copied into an append-only,
time-partitioned archive and verified there before the hot copies may be
released. Receipt deletion is limited to the locked preview IDs. Changed,
expired, missing, or previously used previews cannot delete evidence. Read
timeline events keep their parent-read lifecycle. Application file logs and
PostgreSQL Docker logs remain independently bounded by file rotation.

## Test isolation and validation

Authentication tests run with `NODE_ENV=test` and must set
`ALPR_AUTH_FILE_PATH` to a unique temporary operating-system path. Test mode
throws before authentication storage is read or written when the override is
missing; it never falls back to `auth/auth.json`.

Run the security and application validation with:

```text
npm test
npx --no-install next lint
npm run typecheck
npx --no-install next build
git diff --check
git status --short
```
