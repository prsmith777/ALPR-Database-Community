import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePlateMatchPreference,
  plateMatchPreferenceKey,
  readPlateMatchPreference,
  writePlateMatchPreference,
} from "../lib/plate-match-preference.mjs";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test("plate matching choices persist independently for each page", () => {
  const storage = memoryStorage();

  assert.equal(readPlateMatchPreference("recognition-feed", "balanced", storage), "balanced");
  assert.equal(writePlateMatchPreference("recognition-feed", "strict", storage), "strict");
  assert.equal(writePlateMatchPreference("plate-database", "off", storage), "off");
  assert.equal(writePlateMatchPreference("downloads", "broad", storage), "broad");

  assert.equal(readPlateMatchPreference("recognition-feed", "balanced", storage), "strict");
  assert.equal(readPlateMatchPreference("plate-database", "balanced", storage), "off");
  assert.equal(readPlateMatchPreference("downloads", "balanced", storage), "broad");
});

test("invalid stored choices safely fall back to Balanced", () => {
  const storage = memoryStorage();
  storage.setItem(plateMatchPreferenceKey("recognition-feed"), "default");

  assert.equal(normalizePlateMatchPreference("default"), "balanced");
  assert.equal(readPlateMatchPreference("recognition-feed", "balanced", storage), "balanced");
  assert.throws(
    () => plateMatchPreferenceKey("unknown"),
    /Unsupported plate-matching preference surface/
  );
});
