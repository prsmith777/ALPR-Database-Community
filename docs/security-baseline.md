# Security baseline

- Protected browser routes fail closed when session verification fails, times out, returns malformed data, or returns HTTP 5xx.
- Protected API routes return structured JSON `401` or `503` authentication errors instead of HTML login redirects.
- URL query-parameter API keys such as `?api_key=` are rejected. API clients must use `x-api-key` or `Authorization: Bearer`.
- API keys are never copied to response headers or forwarded headers.
- Session IDs, API keys, sensitive query strings, and full plate-read payloads must not be logged.
- Session cookies are `httpOnly`, `sameSite: "lax"`, `path: "/"`, have an explicit lifetime, and use `Secure` only when `SESSION_COOKIE_SECURE=true`.
- IP whitelist checks are not part of the middleware authentication decision, so spoofed forwarding headers cannot grant access.
