export function plateCorrectionDefaults({ canBatchReview = false, canManageAliases = false } = {}) {
  return { correctAll: canBatchReview === true, rememberAlias: canManageAliases === true };
}

export function isAliasOnlyCorrection(correction) {
  const target = String(correction?.newPlateNumber || "").trim().toUpperCase();
  const current = String(correction?.plateNumber || "").trim().toUpperCase();
  const observed = String(correction?.observedPlate || "").trim().toUpperCase();
  return Boolean(correction?.rememberAlias && target && observed && target === current && target !== observed);
}
