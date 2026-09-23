import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fetchPushoverUsage } from "../lib/pushover-usage.mjs";

test("Pushover usage reports sent, remaining, limit, and reset without returning the token", async () => {
  let requestedUrl;
  const usage = await fetchPushoverUsage({
    token: "secret-application-token",
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      assert.equal(options.method, "GET");
      assert.equal(options.cache, "no-store");
      return new Response(
        JSON.stringify({
          status: 1,
          limit: 10000,
          remaining: 7496,
          reset: 1788242400,
          request: "request-123",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  assert.equal(requestedUrl.origin, "https://api.pushover.net");
  assert.equal(requestedUrl.pathname, "/1/apps/limits.json");
  assert.equal(requestedUrl.searchParams.get("token"), "secret-application-token");
  assert.deepEqual(usage, {
    limit: 10000,
    remaining: 7496,
    used: 2504,
    percentUsed: 25.040000000000003,
    resetAt: "2026-09-01T06:00:00.000Z",
    requestId: "request-123",
    scope: "account",
  });
  assert.equal(JSON.stringify(usage).includes("secret-application-token"), false);
});

test("Pushover usage fails closed for missing credentials and invalid API responses", async () => {
  await assert.rejects(fetchPushoverUsage(), /Configure a Pushover application token/);
  await assert.rejects(
    fetchPushoverUsage({
      token: "bad-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ status: 0, errors: ["application token is invalid"] }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    }),
    /application token is invalid/
  );
});

test("Pushover usage route is permission-protected and the settings UI never receives the token", async () => {
  const [route, card, settings] = await Promise.all([
    readFile(new URL("../app/api/notifications/pushover/usage/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/PushoverUsageCard.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/SettingsForm.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(route, /denyUnlessRoutePermission\("system\.manage_settings"\)/);
  assert.match(route, /config\.notifications\?\.pushover\?\.app_token/);
  assert.match(route, /Cache-Control": "no-store"/);
  assert.match(card, /\/api\/notifications\/pushover\/usage/);
  assert.match(card, /Monthly message allowance/);
  assert.match(card, /Remaining/);
  assert.equal(card.includes("app_token"), false);
  assert.match(settings, /<PushoverUsageCard \/>/);
});
