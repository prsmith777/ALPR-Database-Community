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
