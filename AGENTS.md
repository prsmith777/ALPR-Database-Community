# Security development rules

- Treat authentication and authorization changes as security-sensitive: fail closed, avoid bypasses, and keep route-level checks even when middleware also protects a path.
- Never log API keys, authorization headers, credential-bearing URLs, complete request bodies, AI dumps, image data, session IDs, password hashes, stack traces, filesystem paths, or internal exception details.
- API endpoints must return JSON `401` for missing or invalid credentials and JSON `503` when authentication storage or verification is temporarily unavailable.
- Reject URL query-string credentials such as `?api_key=`. Supported API credentials are `x-api-key: <key>` and `Authorization: Bearer <key>`.
- Compare API keys with constant-time comparison helpers and handle unequal lengths safely.
- Tests that touch authentication state must set `NODE_ENV=test` and `ALPR_AUTH_FILE_PATH` to a unique operating-system temporary directory, then remove the directory and restore environment/module/mock state.
- Tests must never read from or write to the production `auth/auth.json` path unless they are only verifying that a pre-existing canary file remains byte-for-byte unchanged.
