# Security baseline

This document describes the first focused authentication and session-hardening change for the ALPR Database Community fork.

## Current flow inspected

- `middleware.js` protects browser routes and API routes, previously calling public verification endpoints for session and API-key checks.
- `app/actions.js` contains the login and logout server actions that create, store, invalidate, and delete the `session` cookie.
- `lib/auth.js` stores password hashes, sessions, and the integration API key in `auth/auth.json`; it creates sessions, verifies sessions, invalidates sessions, and verifies API keys.
- `app/api/verify-session/route.js` verifies a supplied session identifier.
- `app/api/verify-key/route.js` verifies API keys.
- `app/api/verify-whitelist/route.js` remains the existing IP-whitelist verifier.
- `app/api/plate-reads/route.js` is the Blue Iris ingestion endpoint and remains API-key protected.
- Existing project checks are `yarn lint`, `yarn build`, and the added `yarn test` / `yarn typecheck` scripts.

## Unsafe behaviors corrected

- Protected routes no longer continue merely because session verification fails.
- Session verification exceptions, malformed auth state, network-style verification failures, timeouts, and HTTP 5xx-equivalent dependency failures now fail closed.
- Session IDs and API keys are no longer logged by the touched authentication code.
- Plate-read request payloads are no longer logged wholesale.
- API keys are no longer accepted through `?api_key=...`.
- Accepted API keys are not copied into response headers or forwarded request headers.
- API-key comparison now uses constant-time comparison where practical.
- Session cookie creation and deletion now use one reusable configuration helper.

## New fail-closed behavior

- Missing, invalid, or expired credentials return `401 Unauthorized` for protected API routes.
- Temporary authentication dependency failures return `503 Service Unavailable` for protected API routes.
- Protected browser routes redirect missing, invalid, or expired sessions to `/login`.
- Invalid or expired session cookies are cleared with matching cookie attributes.
- Browser requests are not allowed through when authentication cannot safely be verified; they receive a `503` response instead of fail-open access.

## Browser routes versus API routes

Browser routes receive redirects for ordinary unauthenticated states so users land on `/login`. API routes receive JSON errors and are never redirected to an HTML login page.

## API-key requirements

Integrations must authenticate with one of these headers:

- `x-api-key: <key>`
- `Authorization: Bearer <key>`

URL query parameter authentication with `?api_key=...` is no longer supported because URLs commonly leak into logs, browser history, reverse-proxy telemetry, and referrer data.

## Session cookie behavior

Session cookies are configured with:

- `httpOnly: true`
- `sameSite: "lax"`
- `path: "/"`
- `maxAge: 86400`
- `secure: true` in production

For local HTTP development, set `ALLOW_INSECURE_DEV_COOKIES=true`. Production deployments must not set that variable. If a non-production HTTPS environment needs secure cookies, set `SESSION_COOKIE_SECURE=true`.

## Test commands

Run:

```sh
yarn install --frozen-lockfile
yarn lint
yarn test
yarn typecheck
yarn build
```

## Compatibility considerations

Blue Iris header-based integrations continue to work with `x-api-key` and now also with `Authorization: Bearer`. Blue Iris configurations that placed API keys in URLs must be updated to send a supported header. This is an intentional breaking security change.

## Rollback instructions

Revert the pull request commit and redeploy the previous application version. If rollback is required only for an integration outage, prefer updating the integration to send `x-api-key` rather than re-enabling URL credentials.

## Deferred security work

- Comprehensive authorization checks for every privileged server action.
- Broader audit of all sensitive data logging outside the touched authentication and ingestion paths.
- Review of IP-whitelist trusted-proxy assumptions.
- Migration away from file-backed auth state if multi-instance deployments are required.
- Centralized security event logging with structured redaction.
