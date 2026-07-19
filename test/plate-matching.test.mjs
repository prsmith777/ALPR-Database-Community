import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_PLATE_MATCHING_SETTINGS,
  buildFuzzyPlateSql,
  evaluatePlateMatch,
  normalizePlateMatchingSettings,
  resolvePlateMatchMode,
} from "../lib/plate-matching.mjs";

test("plate matching defaults are conservative and normalized", () => {
  const settings = normalizePlateMatchingSettings({
    defaultMode: "unknown",
    minimumCharacters: 1,
    ocrGroups: ["0O", "OQ", "!!", "1I"],
    profiles: {
      broad: { ordinaryDifferences: 99, ocrDifferences: -1 },
    },
  });

  assert.equal(settings.defaultMode, "balanced");
  assert.equal(settings.minimumCharacters, 3);
  assert.equal(settings.profiles.broad.ordinaryDifferences, 2);
  assert.equal(settings.profiles.broad.ocrDifferences, 0);
  assert.deepEqual(settings.ocrGroups, ["0O", "1I"]);
  assert.equal(resolvePlateMatchMode("default", settings), "balanced");
});

test("strict accepts one configured OCR substitution but not an ordinary one", () => {
  assert.equal(evaluatePlateMatch("7MLG803", "7ML6803", "strict").matched, true);
  assert.equal(evaluatePlateMatch("ABC123", "ABX123", "strict").matched, false);
});

test("balanced handles two OCR substitutions, insertion, and transposition", () => {
  assert.equal(evaluatePlateMatch("B0AB", "80AB", "balanced").matched, true);
  assert.equal(evaluatePlateMatch("ABC123", "ABC12", "balanced").matched, true);
  assert.equal(evaluatePlateMatch("ABC123", "ACB123", "balanced").matched, true);
});

test("broad accepts two ordinary differences while balanced rejects them", () => {
  assert.equal(evaluatePlateMatch("ABC123", "ABX12Y", "balanced").matched, false);
  assert.equal(evaluatePlateMatch("ABC123", "ABX12Y", "broad").matched, true);
});

test("off and minimum length retain standard substring matching only", () => {
  assert.equal(evaluatePlateMatch("ABC", "XXABCYY", "off").matched, true);
  assert.equal(evaluatePlateMatch("ABC", "ABX", "broad").matched, false);
});

test("fuzzy SQL is parameterized and bounded by the selected profile", () => {
  const values = [];
  const result = buildFuzzyPlateSql({
    columnExpression: "pr.plate_number",
    searchValue: "ABC123'); DROP TABLE plates; --",
    requestedMode: "balanced",
    settings: DEFAULT_PLATE_MATCHING_SETTINGS,
    addValue(value) {
      values.push(value);
      return `$${values.length}`;
    },
  });

  assert.equal(result.mode, "balanced");
  assert.match(result.condition, /TRANSLATE/);
  assert.match(result.condition, /LEVENSHTEIN/);
  assert.match(result.condition, /ANY\(\$\d+::text\[\]\)/);
  assert.equal(result.condition.includes("DROP TABLE"), false);
  assert.equal(values[0], "ABC123DROPTABLEPLATES");
  assert.ok(values.includes(1));
  assert.ok(values.includes(2));
});

test("matching settings are persisted and exposed in all three interfaces", async () => {
  const [settingsSource, actions, settingsForm, liveFeed, database, downloads] =
    await Promise.all([
      readFile(new URL("../lib/settings.js", import.meta.url), "utf8"),
      readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
      readFile(new URL("../app/settings/SettingsForm.jsx", import.meta.url), "utf8"),
      readFile(new URL("../components/PlateTable.jsx", import.meta.url), "utf8"),
      readFile(new URL("../components/PlateDatabaseFilters.jsx", import.meta.url), "utf8"),
      readFile(new URL("../components/PlateExportForm.jsx", import.meta.url), "utf8"),
    ]);

  assert.match(settingsSource, /normalizePlateMatchingSettings/);
  assert.match(actions, /formData\.get\("plateMatching"\)/);
  assert.match(settingsForm, /PlateMatchingSettings/);
  assert.match(liveFeed, /PlateMatchModeSelect/);
  assert.equal(liveFeed.includes("const [isSearchOptionsOpen, setIsSearchOptionsOpen] = useState(false);"), true);
  assert.match(liveFeed, /Plate search, matching, and filters/);
  assert.equal(liveFeed.includes("aria-expanded={isSearchOptionsOpen}"), true);
  assert.match(database, /PlateMatchModeSelect/);
  assert.match(downloads, /PlateMatchModeSelect/);
});
