# Security baseline

## API authentication

Protected API requests are authenticated with shared server-side helpers from `lib/auth.js`. URL query credentials such as `?api_key=` are rejected. Supported API credential forms are:

- `x-api-key: <key>`
- `Authorization: Bearer <key>`

Missing or invalid API credentials return JSON `401`. Temporary authentication storage or verification failures return JSON `503`. API key comparison uses `crypto.timingSafeEqual` and rejects unequal byte lengths before comparison so verification does not throw.

## `/api/plate-reads`

`/api/plate-reads` is protected in middleware and again in the route handler. The handler calls the shared authorization helper before parsing `req.json()`, so direct route invocation or middleware bypass still requires valid credentials. After authentication succeeds, the existing Blue Iris plate-processing flow is preserved.

The route logs only a generic message (`Received authenticated plate-read request`) and must not log full payloads, AI dumps, images, API keys, authorization headers, credential-bearing URLs, stack traces, file paths, or raw internal errors. Client error responses use generic messages.

## Browser sessions and cookies

Browser routes require valid session verification. Missing, invalid, expired, timed-out, network-failed, HTTP 5xx, or malformed session verification responses fail closed instead of granting access. Session cookie creation and deletion use matching attributes. Direct LAN HTTP uses non-`Secure` cookies, while explicit HTTPS uses `Secure` cookies.

## Test authentication isolation

Authentication tests must set `NODE_ENV=test` and `ALPR_AUTH_FILE_PATH`. In test mode, auth code throws before reading or writing if `ALPR_AUTH_FILE_PATH` is absent. Tests use unique operating-system temporary directories and remove them after each applicable test. They restore environment variables, module cache state, and mocked globals. Tests must never fall back to `auth/auth.json`; canary checks either prove a real file is byte-for-byte unchanged or prove no real file was created.
