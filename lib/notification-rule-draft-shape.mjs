const CONDITION_SPECS = Object.freeze({
  known_plate: { operator: "is_true" },
  tag: { operator: "any" },
  camera: { operator: "in" },
});

function conditionList(group) {
  return Array.isArray(group?.children) ? group.children : [];
}

function isAllGroup(group) {
  return group?.kind === "group" && group.combinator === "all" && group.negated !== true;
}

function validCondition(condition) {
  const spec = CONDITION_SPECS[condition?.conditionType];
  return condition?.kind === "condition" && Boolean(spec) && condition.operator === spec.operator;
}

function stringValues(condition, key) {
  const values = condition?.value?.[key];
  if (!Array.isArray(values)) return null;
  const normalized = values.map((value) => String(value ?? "").trim()).filter(Boolean);
  return normalized.length === values.length && normalized.length > 0 ? normalized : null;
}

export function normalizeEditableTagCameraTree(root) {
  if (!isAllGroup(root)) return null;
  const rootChildren = conditionList(root);
  const nestedGroups = rootChildren.filter((child) => child?.kind === "group");
  let conditions;

  if (nestedGroups.length === 0) {
    conditions = rootChildren;
  } else if (nestedGroups.length === 1 && rootChildren.length === 2) {
    const nested = nestedGroups[0];
    const rootCondition = rootChildren.find((child) => child?.kind === "condition");
    const nestedConditions = conditionList(nested);
    if (
      !isAllGroup(nested) ||
      rootCondition?.conditionType !== "camera" ||
      nestedConditions.length !== 2 ||
      nestedConditions.some((condition) => condition?.kind !== "condition")
    ) return null;
    conditions = [...nestedConditions, rootCondition];
  } else {
    return null;
  }

  if (conditions.length < 2 || conditions.length > 3 || conditions.some((condition) => !validCondition(condition))) {
    return null;
  }
  const known = conditions.filter((condition) => condition.conditionType === "known_plate");
  const tags = conditions.filter((condition) => condition.conditionType === "tag");
  const cameras = conditions.filter((condition) => condition.conditionType === "camera");
  if (known.length > 1 || tags.length !== 1 || cameras.length !== 1) return null;
  if (known.length === 1 && known[0]?.value?.expected !== true) return null;
  const tagValues = stringValues(tags[0], "tags");
  const cameraValues = stringValues(cameras[0], "names");
  if (!tagValues || !cameraValues) return null;

  return {
    requireKnownPlate: known.length === 1,
    tags: tagValues,
    cameras: cameraValues,
  };
}

export const notificationRuleDraftShapeInternals = Object.freeze({
  CONDITION_SPECS,
  conditionList,
  isAllGroup,
  stringValues,
  validCondition,
});
