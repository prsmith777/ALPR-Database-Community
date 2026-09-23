import test from "node:test";
import assert from "node:assert/strict";

import {
  getSessionCookieDeletionOptions,
  getSessionCookieOptions,
} from "../lib/session-cookie.mjs";

test("session cookies are HttpOnly and SameSite=Lax", () => {
  const options = getSessionCookieOptions({});
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/");
  assert.equal(options.maxAge, 86400);
});

test("session cookies default to non-Secure", () => {
  assert.equal(getSessionCookieOptions({}).secure, false);
});

test("SESSION_COOKIE_SECURE=true enables Secure", () => {
  assert.equal(
    getSessionCookieOptions({ SESSION_COOKIE_SECURE: "true" }).secure,
    true
  );
});

test("SESSION_COOKIE_SECURE=false keeps cookies non-Secure", () => {
  assert.equal(
    getSessionCookieOptions({ SESSION_COOKIE_SECURE: "false" }).secure,
    false
  );
});

test("other SESSION_COOKIE_SECURE values keep cookies non-Secure", () => {
  assert.equal(
    getSessionCookieOptions({ SESSION_COOKIE_SECURE: "TRUE" }).secure,
    false
  );
});

test("cookie creation and deletion security attributes match", () => {
  const env = { SESSION_COOKIE_SECURE: "true" };
  const created = getSessionCookieOptions(env);
  const deleted = getSessionCookieDeletionOptions(env);

  for (const name of ["httpOnly", "secure", "sameSite", "path"]) {
    assert.equal(deleted[name], created[name]);
  }
  assert.equal(deleted.maxAge, 0);
  assert.equal(deleted.expires.getTime(), 0);
});
