import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_FEED_POPUP_VIEW_STORAGE_KEY,
  loadLiveFeedPopupView,
  normalizeLiveFeedPopupView,
  saveLiveFeedPopupView,
} from "../lib/live-feed-popup-preference.mjs";

test("live feed popup view defaults safely to plate capture", () => {
  assert.equal(normalizeLiveFeedPopupView(undefined), "plate");
  assert.equal(normalizeLiveFeedPopupView("invalid"), "plate");
  assert.equal(loadLiveFeedPopupView(null), "plate");
  assert.equal(loadLiveFeedPopupView({ getItem: () => { throw new Error("denied"); } }), "plate");
});

test("live feed popup view survives a component and login-session remount", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  assert.equal(saveLiveFeedPopupView("vehicle", storage), "vehicle");
  assert.equal(values.get(LIVE_FEED_POPUP_VIEW_STORAGE_KEY), "vehicle");
  assert.equal(loadLiveFeedPopupView(storage), "vehicle");
  assert.equal(saveLiveFeedPopupView("plate", storage), "plate");
  assert.equal(loadLiveFeedPopupView(storage), "plate");
});

test("live feed popup keeps the in-memory choice when storage writes are denied", () => {
  assert.equal(
    saveLiveFeedPopupView("vehicle", { setItem: () => { throw new Error("denied"); } }),
    "vehicle"
  );
});
