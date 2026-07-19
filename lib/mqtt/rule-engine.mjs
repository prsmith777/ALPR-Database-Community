import { findBestPlateMatch } from "./fuzzy-match.mjs";
import { normalizePlate } from "./plate-normalize.mjs";
import {
  renderCameraTopic,
  validatePublishTopic,
} from "./topic-template.mjs";

const MATCH_TYPES = new Set([
  "any_plate",
  "exact_plate",
  "any_known_plate",
  "known_name",
  "tag",
]);

const DESTINATION_MODES = new Set(["per_camera", "fixed_topic"]);

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function normalizeText(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en-US");
}

function getRuleValue(rule, camelName, snakeName, fallback = undefined) {
  return firstDefined(rule?.[camelName], rule?.[snakeName], fallback);
}

function getRuleName(rule) {
  return String(getRuleValue(rule, "name", "name", "Unnamed MQTT rule")).trim();
}

function getRuleId(rule) {
  return getRuleValue(rule, "id", "id", null);
}

function getMatchType(rule) {
  return String(getRuleValue(rule, "matchType", "match_type", "")).trim();
}

function getMatchValue(rule) {
  return String(getRuleValue(rule, "matchValue", "match_value", "")).trim();
}

function getBrokerId(rule) {
  return getRuleValue(rule, "brokerId", "broker_id", null);
}

function getDestinationMode(rule) {
  return String(
    getRuleValue(rule, "destinationMode", "destination_mode", "per_camera")
  ).trim();
}

function getFixedTopic(rule) {
  return String(getRuleValue(rule, "fixedTopic", "fixed_topic", "")).trim();
}

function getCameraIds(rule) {
  const values = firstDefined(rule?.cameraIds, rule?.camera_ids, []);
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => String(value))
    .filter((value) => value.length > 0);
}

function getCandidateTags(candidate) {
  const tags = Array.isArray(candidate?.tags) ? candidate.tags : [];

  return tags
    .map((tag) => {
      if (typeof tag === "string") return tag;
      return firstDefined(tag?.name, tag?.tag_name, "");
    })
    .map((tag) => String(tag).trim())
    .filter(Boolean);
}

function normalizeKnownCandidate(candidate) {
  const plateNumber = firstDefined(
    candidate?.plateNumber,
    candidate?.plate_number,
    ""
  );
  const normalizedPlate = normalizePlate(plateNumber);

  return {
    ...candidate,
    plateNumber: normalizedPlate,
    plate_number: normalizedPlate,
    name: String(candidate?.name ?? candidate?.plate_name ?? "").trim(),
    tags: getCandidateTags(candidate),
  };
}

export function normalizeKnownPlateCandidates(candidates = []) {
  const unique = new Map();

  for (const rawCandidate of candidates ?? []) {
    const candidate = normalizeKnownCandidate(rawCandidate);
    if (!candidate.plateNumber) continue;
    if (!unique.has(candidate.plateNumber)) {
      unique.set(candidate.plateNumber, candidate);
    }
  }

  return [...unique.values()];
}

function cameraMatchesRule(rule, camera) {
  const selectedCameraIds = getCameraIds(rule);
  if (selectedCameraIds.length === 0) return true;

  const cameraId = firstDefined(camera?.id, camera?.cameraId, camera?.camera_id, null);
  if (cameraId === null) return false;

  return selectedCameraIds.includes(String(cameraId));
}

function fuzzyOptionsFromRule(rule, matchingSettings) {
  const plateMatchMode = getRuleValue(
    rule,
    "plateMatchMode",
    "plate_match_mode",
    null
  );

  if (plateMatchMode !== null && plateMatchMode !== "") {
    return {
      matchMode: String(plateMatchMode).trim().toLowerCase(),
      matchingSettings,
      requireUnique: true,
    };
  }

  // Compatibility for rules saved before profile-based MQTT matching.
  return {
    fuzzyEnabled: Boolean(
      getRuleValue(rule, "fuzzyEnabled", "fuzzy_enabled", false)
    ),
    maxDistance: Number(
      getRuleValue(rule, "fuzzyMaxDistance", "fuzzy_max_distance", 1)
    ),
    minimumPlateLength: Number(
      getRuleValue(rule, "fuzzyMinLength", "fuzzy_min_length", 5)
    ),
    requireUnique: Boolean(
      getRuleValue(rule, "fuzzyRequireUnique", "fuzzy_require_unique", true)
    ),
    ocrAware: Boolean(
      getRuleValue(rule, "fuzzyOcrAware", "fuzzy_ocr_aware", true)
    ),
  };
}

function decisionBase(rule, observedPlate) {
  return {
    ruleId: getRuleId(rule),
    ruleName: getRuleName(rule),
    message: String(
      getRuleValue(rule, "message", "message", "")
    ).trim(),
    matchType: getMatchType(rule),
    observedPlate,
    matched: false,
    reason: "not-matched",
    matchMethod: "none",
    matchedPlateNumber: "",
    matchDistance: null,
    matchQuality: "none",
    candidate: null,
  };
}

function matchedDecision(base, match, candidate = null) {
  return {
    ...base,
    matched: true,
    reason: "matched",
    matchMethod: match.status,
    matchedPlateNumber: match.matchedPlateNumber,
    matchDistance: match.distance,
    matchQuality: match.quality,
    candidate,
  };
}

function findExactKnownCandidate(observedPlate, knownCandidates) {
  return knownCandidates.find(
    (candidate) => candidate.plateNumber === observedPlate
  );
}

function resolveKnownCandidate(
  rule,
  observedPlate,
  knownCandidates,
  matchingSettings
) {
  return findBestPlateMatch(
    observedPlate,
    knownCandidates,
    fuzzyOptionsFromRule(rule, matchingSettings)
  );
}

/**
 * Evaluate one rule against one camera observation.
 *
 * Identity-based fuzzy rules always resolve against the complete known-plate
 * set before checking a name or tag. This prevents a scoped rule from claiming
 * a plate when an equally close known plate exists outside that scope.
 */
export function evaluateMqttRule(
  rule,
  {
    observedPlate: observedValue,
    camera = null,
    knownPlates = [],
    matchingSettings = {},
  } = {}
) {
  const observedPlate = normalizePlate(observedValue);
  const base = decisionBase(rule, observedPlate);

  if (rule?.enabled === false) return { ...base, reason: "rule-disabled" };
  if (!observedPlate) return { ...base, reason: "empty-observation" };
  if (!cameraMatchesRule(rule, camera)) {
    return { ...base, reason: "camera-filtered" };
  }

  const matchType = getMatchType(rule);
  if (!MATCH_TYPES.has(matchType)) {
    return { ...base, reason: "invalid-match-type" };
  }

  const knownCandidates = normalizeKnownPlateCandidates(knownPlates);

  if (matchType === "any_plate") {
    const exactKnown = findExactKnownCandidate(observedPlate, knownCandidates);
    return {
      ...base,
      matched: true,
      reason: "matched",
      matchMethod: "exact",
      matchedPlateNumber: exactKnown?.plateNumber ?? observedPlate,
      matchDistance: 0,
      matchQuality: "exact",
      candidate: exactKnown ?? null,
    };
  }

  if (matchType === "exact_plate") {
    const configuredPlate = normalizePlate(getMatchValue(rule));
    if (!configuredPlate) return { ...base, reason: "missing-match-value" };

    const match = findBestPlateMatch(observedPlate, [configuredPlate], {
      ...fuzzyOptionsFromRule(rule, matchingSettings),
      requireUnique: true,
    });

    if (match.status !== "exact" && match.status !== "fuzzy") {
      return { ...base, reason: match.reason };
    }

    const knownCandidate = knownCandidates.find(
      (candidate) => candidate.plateNumber === match.matchedPlateNumber
    );
    return matchedDecision(base, match, knownCandidate ?? null);
  }

  const match = resolveKnownCandidate(
    rule,
    observedPlate,
    knownCandidates,
    matchingSettings
  );
  if (match.status !== "exact" && match.status !== "fuzzy") {
    return { ...base, reason: match.reason };
  }

  const candidate = normalizeKnownCandidate(match.candidate);

  if (matchType === "any_known_plate") {
    return matchedDecision(base, match, candidate);
  }

  const configuredValue = normalizeText(getMatchValue(rule));
  if (!configuredValue) return { ...base, reason: "missing-match-value" };

  if (matchType === "known_name") {
    if (normalizeText(candidate.name) !== configuredValue) {
      return { ...base, reason: "known-name-mismatch" };
    }
    return matchedDecision(base, match, candidate);
  }

  const candidateTags = candidate.tags.map(normalizeText);
  if (!candidateTags.includes(configuredValue)) {
    return { ...base, reason: "tag-mismatch" };
  }

  return matchedDecision(base, match, candidate);
}

export function evaluateMqttRules(rules = [], context = {}) {
  const decisions = (rules ?? []).map((rule) =>
    evaluateMqttRule(rule, context)
  );

  return {
    decisions,
    matches: decisions.filter((decision) => decision.matched),
  };
}

function resolveTopicForRule(rule, camera, settings) {
  const destinationMode = getDestinationMode(rule);
  if (!DESTINATION_MODES.has(destinationMode)) {
    throw new Error(`Invalid MQTT destination mode: ${destinationMode}`);
  }

  if (destinationMode === "fixed_topic") {
    return validatePublishTopic(getFixedTopic(rule));
  }

  return renderCameraTopic({
    baseTopic: firstDefined(settings?.baseTopic, settings?.base_topic, "alpr"),
    template: firstDefined(
      settings?.cameraTopicTemplate,
      settings?.camera_topic_template,
      "{base_topic}/{camera_key}"
    ),
    cameraName: firstDefined(
      camera?.cameraName,
      camera?.camera_name,
      camera?.name,
      ""
    ),
    cameraKey: firstDefined(camera?.cameraKey, camera?.camera_key, ""),
    topicOverride: firstDefined(
      camera?.topicOverride,
      camera?.topic_override,
      ""
    ),
  });
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

/**
 * Consolidate several matching rules into one publication per broker/topic for
 * this single camera observation. A different camera observation is evaluated
 * separately and therefore always creates its own publication.
 */
export function planMqttPublications({
  rules = [],
  observedPlate,
  camera,
  knownPlates = [],
  settings = {},
  matchingSettings = {},
} = {}) {
  const { decisions, matches } = evaluateMqttRules(rules, {
    observedPlate,
    camera,
    knownPlates,
    matchingSettings,
  });

  const groups = new Map();

  for (const match of matches) {
    const rule = (rules ?? []).find((candidateRule) => {
      const candidateId = getRuleId(candidateRule);
      return candidateId === match.ruleId;
    });

    if (!rule) continue;

    const brokerId = getBrokerId(rule);
    if (brokerId === null || brokerId === "") {
      const decision = decisions.find(
        (candidateDecision) => candidateDecision.ruleId === match.ruleId
      );
      if (decision) {
        decision.matched = false;
        decision.reason = "missing-broker";
      }
      continue;
    }

    let topic;
    try {
      topic = resolveTopicForRule(rule, camera, settings);
    } catch (error) {
      const decision = decisions.find(
        (candidateDecision) => candidateDecision.ruleId === match.ruleId
      );
      if (decision) {
        decision.matched = false;
        decision.reason = "invalid-topic";
        decision.error = error.message;
      }
      continue;
    }

    const key = `${String(brokerId)}\u0000${topic}`;
    const existing = groups.get(key) ?? {
      brokerId,
      topic,
      matches: [],
    };
    existing.matches.push(match);
    groups.set(key, existing);
  }

  const publications = [...groups.values()].map((group) => {
    // An any-plate rule is routing evidence, not necessarily identity
    // evidence. When it matched an unknown observed value, do not let that
    // generic value conflict with a stronger exact or fuzzy known identity.
    const identityMatches = group.matches.filter(
      (match) => match.matchType !== "any_plate" || match.candidate
    );
    const evidenceMatches =
      identityMatches.length > 0 ? identityMatches : group.matches;

    const canonicalPlates = uniqueNonEmpty(
      identityMatches.map((match) => match.matchedPlateNumber)
    );
    const identityConflict = canonicalPlates.length > 1;
    const candidates = identityMatches
      .map((match) => match.candidate)
      .filter(Boolean);

    return {
      brokerId: group.brokerId,
      topic: group.topic,
      ruleIds: group.matches.map((match) => match.ruleId),
      ruleNames: uniqueNonEmpty(group.matches.map((match) => match.ruleName)),
      matchedBy: uniqueNonEmpty(group.matches.map((match) => match.matchType)),
      matchMethods: uniqueNonEmpty(
        evidenceMatches.map((match) => match.matchMethod)
      ),
      matchedPlateNumber: identityConflict ? "" : canonicalPlates[0] ?? "",
      matchDistance:
        evidenceMatches
          .map((match) => match.matchDistance)
          .filter((distance) => Number.isInteger(distance))
          .sort((left, right) => left - right)[0] ?? null,
      identityConflict,
      candidate: identityConflict ? null : candidates[0] ?? null,
      evidenceMatches,
      matches: group.matches,
    };
  });

  return { decisions, publications };
}
