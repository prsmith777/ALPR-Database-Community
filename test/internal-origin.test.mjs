import test from "node:test";
import assert from "node:assert/strict";

import {
  getTrustedInternalOrigin,
  getTrustedInternalUrl,
} from "../lib/internal-origin.mjs";

test("configured internal URLs are normalized to their trusted origin", () => {
  const env = {
    ALPR_INTERNAL_ORIGIN: "https://internal.example:8443/application/base",
  };

  assert.equal(
    getTrustedInternalOrigin(env),
    "https://internal.example:8443"
  );
  assert.equal(
    getTrustedInternalUrl("/api/verify-key", env).href,
    "https://internal.example:8443/api/verify-key"
  );
});

test("default internal origin uses loopback with PORT or port 3000", () => {
  assert.equal(
    getTrustedInternalOrigin({ PORT: "4312" }),
    "http://127.0.0.1:4312"
  );
  assert.equal(getTrustedInternalOrigin({}), "http://127.0.0.1:3000");
});

test("invalid configured internal origins and ports are rejected", () => {
  for (const env of [
    { ALPR_INTERNAL_ORIGIN: "" },
    { ALPR_INTERNAL_ORIGIN: "not-a-url" },
    { ALPR_INTERNAL_ORIGIN: "ftp://internal.example" },
    { ALPR_INTERNAL_ORIGIN: "http://user@internal.example" },
    { ALPR_INTERNAL_ORIGIN: "http://user:pass@internal.example" },
    { ALPR_INTERNAL_ORIGIN: "http://internal.example?target=other" },
    { ALPR_INTERNAL_ORIGIN: "http://internal.example#fragment" },
    { PORT: "3000@attacker.example" },
    { PORT: "0" },
    { PORT: "65536" },
  ]) {
    assert.throws(() => getTrustedInternalOrigin(env), TypeError);
  }
});
