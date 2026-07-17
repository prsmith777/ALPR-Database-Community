import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateMqttRule,
  evaluateMqttRules,
  planMqttPublications,
} from "../lib/mqtt/rule-engine.mjs";

const knownPlates = [
  {
    plate_number: "DPOM90",
    name: "Liz's Lexus",
    tags: ["Family", "Resident"],
  },
  {
    plate_number: "ABC123",
    name: "Paul's Truck",
    tags: ["Family"],
  },
  {
    plate_number: "ABC128",
    name: "Contractor Van",
    tags: ["Contractor"],
  },
];

const entryCamera1 = {
  id: 11,
  camera_name: "Entry LPR 1",
  camera_key: "entry-lpr-1",
};

const entryCamera2 = {
  id: 12,
  camera_name: "Entry LPR 2",
  camera_key: "entry-lpr-2",
};

function baseRule(overrides = {}) {
  return {
    id: 1,
    name: "Test rule",
    enabled: true,
    match_type: "exact_plate",
    match_value: "DPOM90",
    fuzzy_enabled: false,
    fuzzy_max_distance: 1,
    fuzzy_min_length: 5,
    fuzzy_require_unique: true,
    fuzzy_ocr_aware: true,
    camera_ids: [],
    broker_id: 5,
    destination_mode: "per_camera",
    fixed_topic: "",
    ...overrides,
  };
}

test("exact-plate rules can optionally accept one-character OCR mistakes", () => {
  const exactOnly = evaluateMqttRule(baseRule(), {
    observedPlate: "DP0M90",
    camera: entryCamera1,
    knownPlates,
  });
  assert.equal(exactOnly.matched, false);
  assert.equal(exactOnly.reason, "fuzzy-disabled");

  const fuzzy = evaluateMqttRule(
    baseRule({ fuzzy_enabled: true }),
    {
      observedPlate: "DP0M90",
      camera: entryCamera1,
      knownPlates,
    }
  );

  assert.equal(fuzzy.matched, true);
  assert.equal(fuzzy.matchMethod, "fuzzy");
  assert.equal(fuzzy.matchedPlateNumber, "DPOM90");
  assert.equal(fuzzy.matchDistance, 1);
  assert.equal(fuzzy.candidate.name, "Liz's Lexus");
});

test("known-plate, known-name, and tag rules match the canonical identity", () => {
  const rules = [
    baseRule({ id: 1, match_type: "any_known_plate", match_value: "" }),
    baseRule({ id: 2, match_type: "known_name", match_value: "Liz's Lexus" }),
    baseRule({ id: 3, match_type: "tag", match_value: "family" }),
  ];

  const result = evaluateMqttRules(rules, {
    observedPlate: "dpom90",
    camera: entryCamera1,
    knownPlates,
  });

  assert.equal(result.matches.length, 3);
  assert.deepEqual(
    result.matches.map((match) => match.matchedPlateNumber),
    ["DPOM90", "DPOM90", "DPOM90"]
  );
});

test("fuzzy tag rules resolve globally before checking tag membership", () => {
  const result = evaluateMqttRule(
    baseRule({
      match_type: "tag",
      match_value: "Family",
      fuzzy_enabled: true,
    }),
    {
      observedPlate: "ABC129",
      camera: entryCamera1,
      knownPlates,
    }
  );

  assert.equal(result.matched, false);
  assert.equal(result.reason, "no-unique-best-match");
});

test("a unique fuzzy known match can satisfy a name or tag rule", () => {
  const nameResult = evaluateMqttRule(
    baseRule({
      id: 1,
      match_type: "known_name",
      match_value: "Liz's Lexus",
      fuzzy_enabled: true,
    }),
    {
      observedPlate: "DP0M90",
      camera: entryCamera1,
      knownPlates,
    }
  );

  const tagResult = evaluateMqttRule(
    baseRule({
      id: 2,
      match_type: "tag",
      match_value: "Resident",
      fuzzy_enabled: true,
    }),
    {
      observedPlate: "DP0M90",
      camera: entryCamera1,
      knownPlates,
    }
  );

  assert.equal(nameResult.matched, true);
  assert.equal(tagResult.matched, true);
  assert.equal(nameResult.matchedPlateNumber, "DPOM90");
  assert.equal(tagResult.matchedPlateNumber, "DPOM90");
});

test("camera filters allow one or several selected cameras", () => {
  const rule = baseRule({ camera_ids: [11, 12] });

  assert.equal(
    evaluateMqttRule(rule, {
      observedPlate: "DPOM90",
      camera: entryCamera1,
      knownPlates,
    }).matched,
    true
  );

  assert.equal(
    evaluateMqttRule(rule, {
      observedPlate: "DPOM90",
      camera: { id: 13, camera_name: "Road LPR", camera_key: "road-lpr" },
      knownPlates,
    }).reason,
    "camera-filtered"
  );
});

test("disabled and malformed rules produce explicit decisions", () => {
  assert.equal(
    evaluateMqttRule(baseRule({ enabled: false }), {
      observedPlate: "DPOM90",
      camera: entryCamera1,
      knownPlates,
    }).reason,
    "rule-disabled"
  );

  assert.equal(
    evaluateMqttRule(baseRule({ match_type: "unsupported" }), {
      observedPlate: "DPOM90",
      camera: entryCamera1,
      knownPlates,
    }).reason,
    "invalid-match-type"
  );
});

test("matching rules for one camera and destination consolidate into one publish", () => {
  const rules = [
    baseRule({ id: 1, name: "Family", match_type: "tag", match_value: "Family" }),
    baseRule({
      id: 2,
      name: "Known vehicles",
      match_type: "any_known_plate",
      match_value: "",
    }),
    baseRule({
      id: 3,
      name: "Liz's Lexus",
      match_type: "known_name",
      match_value: "Liz's Lexus",
    }),
  ];

  const result = planMqttPublications({
    rules,
    observedPlate: "DPOM90",
    camera: entryCamera1,
    knownPlates,
    settings: {
      base_topic: "Blue Iris/ALPR",
      camera_topic_template: "{base_topic}/{camera_key}",
    },
  });

  assert.equal(result.publications.length, 1);
  assert.equal(result.publications[0].topic, "Blue Iris/ALPR/entry-lpr-1");
  assert.deepEqual(result.publications[0].ruleNames, [
    "Family",
    "Known vehicles",
    "Liz's Lexus",
  ]);
  assert.equal(result.publications[0].matchedPlateNumber, "DPOM90");
  assert.equal(result.publications[0].identityConflict, false);
});

test("different camera observations always plan independent camera topics", () => {
  const rules = [
    baseRule({ id: 1, match_type: "tag", match_value: "Family" }),
  ];
  const settings = {
    base_topic: "Blue Iris/ALPR",
    camera_topic_template: "{base_topic}/{camera_key}",
  };

  const first = planMqttPublications({
    rules,
    observedPlate: "DPOM90",
    camera: entryCamera1,
    knownPlates,
    settings,
  });
  const second = planMqttPublications({
    rules,
    observedPlate: "DPOM90",
    camera: entryCamera2,
    knownPlates,
    settings,
  });

  assert.equal(first.publications[0].topic, "Blue Iris/ALPR/entry-lpr-1");
  assert.equal(second.publications[0].topic, "Blue Iris/ALPR/entry-lpr-2");
});

test("different brokers or fixed topics remain separate publications", () => {
  const rules = [
    baseRule({ id: 1, broker_id: 5 }),
    baseRule({ id: 2, broker_id: 6 }),
    baseRule({
      id: 3,
      broker_id: 5,
      destination_mode: "fixed_topic",
      fixed_topic: "homeassistant/alpr/events",
    }),
  ];

  const result = planMqttPublications({
    rules,
    observedPlate: "DPOM90",
    camera: entryCamera1,
    knownPlates,
    settings: {
      base_topic: "alpr",
      camera_topic_template: "{base_topic}/{camera_key}",
    },
  });

  assert.equal(result.publications.length, 3);
  assert.deepEqual(
    result.publications.map((publication) => [publication.brokerId, publication.topic]),
    [
      [5, "alpr/entry-lpr-1"],
      [6, "alpr/entry-lpr-1"],
      [5, "homeassistant/alpr/events"],
    ]
  );
});

test("invalid destinations are rejected without blocking other rules", () => {
  const rules = [
    baseRule({
      id: 1,
      destination_mode: "fixed_topic",
      fixed_topic: "bad/+/topic",
    }),
    baseRule({ id: 2, name: "Valid rule" }),
  ];

  const result = planMqttPublications({
    rules,
    observedPlate: "DPOM90",
    camera: entryCamera1,
    knownPlates,
    settings: {
      base_topic: "alpr",
      camera_topic_template: "{base_topic}/{camera_key}",
    },
  });

  assert.equal(result.publications.length, 1);
  assert.equal(result.publications[0].topic, "alpr/entry-lpr-1");
  assert.equal(result.decisions[0].matched, false);
  assert.equal(result.decisions[0].reason, "invalid-topic");
});
