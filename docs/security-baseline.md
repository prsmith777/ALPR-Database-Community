# Security baseline

## API authentication

Integration API routes are explicitly classified separately from browser-session application APIs. `/api/plate-reads` and `/api/plates` require integration API credentials. URL query credentials such as `?api_key=` are rejected. Supported API credential forms are:

- `x-api-key: <key>`
- `Authorization: Bearer <key>`

Missing or invalid integration API credentials return JSON `401`. Temporary authentication storage or verification failures return JSON `503`. API key comparison uses `crypto.timingSafeEqual` and rejects unequal byte lengths before comparison so verification does not throw. Other protected `/api/...` application routes use the browser session cookie; they return JSON `401` for a missing or invalid session and JSON `503` if session verification times out, fails over the network, returns HTTP 5xx, or returns malformed JSON. API clients are never redirected to HTML login pages.

## `/api/plate-reads`

`/api/plate-reads` is protected in middleware and again in the route handler. The handler calls the shared authorization helper before parsing `req.json()`, so direct route invocation or middleware bypass still requires valid credentials. After authentication succeeds, the existing Blue Iris plate-processing flow is preserved.

The route logs only a generic message (`Received authenticated plate-read request`) and must not log full payloads, AI dumps, images, API keys, authorization headers, credential-bearing URLs, stack traces, file paths, or raw internal errors. Client error responses use generic messages.

## Browser sessions and cookies

Browser routes require valid session verification. Missing, invalid, expired, timed-out, network-failed, HTTP 5xx, or malformed session verification responses fail closed instead of granting access. Middleware no longer uses IP-whitelist authentication and never forwards client-controlled headers to `/api/verify-whitelist`; spoofed `X-Forwarded-For` headers do not grant access. Session cookie creation and deletion use matching `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` attributes. Cookies default to non-`Secure` for direct LAN HTTP Docker deployments. Set `SESSION_COOKIE_SECURE=true` to emit `Secure` cookies; set `SESSION_COOKIE_SECURE=false` or leave it unset for non-`Secure` cookies. Cookie security is not inferred from request headers such as `X-Forwarded-Proto`.

## Test authentication isolation

Authentication tests must set `NODE_ENV=test` and `ALPR_AUTH_FILE_PATH`. In test mode, auth code throws before reading or writing if `ALPR_AUTH_FILE_PATH` is absent. Tests use unique operating-system temporary directories and remove them after each applicable test. They restore environment variables, module cache state, and mocked globals. Tests must never fall back to `auth/auth.json`; canary checks either prove a real file is byte-for-byte unchanged or prove no real file was created.
