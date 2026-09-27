export const NATIVE_REID_MIGRATION = "2026092701_native_reid";
// Upgrade-only compatibility inventory. These retired derived tables are never
// read by the application; exact pre-migration restore checks still include them.
export const RETIRED_IDENTITY_TABLES = Object.freeze([
  "vehicle_reid_v2_conversion_v1_comparisons",
  "vehicle_reid_v2_conversion_conflicts",
  "vehicle_reid_v2_conversion_read_dispositions",
  "vehicle_reid_v2_conversion_projected_members",
  "vehicle_reid_v2_conversion_projected_profiles",
  "vehicle_reid_v2_conversion_jobs",
  "vehicle_reid_v2_conversion_review_evidence",
  "vehicle_reid_v2_conversion_read_evidence",
  "vehicle_reid_v2_conversion_crop_evidence",
  "vehicle_reid_v2_conversion_runs",
  "vehicle_plate_associations",
  "vehicle_cluster_assignments",
  "vehicle_clusters",
  "vehicle_match_feedback",
  "capture_assets",
  "camera_visual_profiles",
  "vehicle_attribute_observations",
]);
export const RETIRED_DIRECTION_PREDICATES = Object.freeze({
  vehicle_orientation_labels: "TRUE",
  vehicle_direction_observations: "classifier_version <> 'blue-iris-zone-crossing-v1'",
});
export function compareMinimumCounts(sourceCounts, targetCounts) {
  const losses = [];
  for (const [table, sourceCount] of Object.entries(sourceCounts)) {
    const targetCount = targetCounts[table];
    if (targetCount === undefined) {
      losses.push({ table, source: sourceCount, target: "missing" });
    } else if (BigInt(targetCount) < BigInt(sourceCount)) {
      losses.push({ table, source: sourceCount, target: targetCount });
    }
  }
  return losses;
}

export function compareNativeUpgradeCounts(sourceCounts, targetCounts, {
  sourceNative = false, targetNative = false, directionRetirements = {},
} = {}) {
  const adjustedCounts = { ...sourceCounts };
  const retiredDerivedRows = [];
  const unexpectedRetained = [];
  if (!sourceNative && targetNative) {
    for (const table of RETIRED_IDENTITY_TABLES) {
      if (sourceCounts[table] === undefined) continue;
      if (targetCounts[table] !== undefined) {
        unexpectedRetained.push({ table, reason: "retired derived table still exists" });
        continue;
      }
      retiredDerivedRows.push({ table, retired: sourceCounts[table], reason: "retired derived table" });
      delete adjustedCounts[table];
    }
    for (const table of Object.keys(RETIRED_DIRECTION_PREDICATES)) {
      if (sourceCounts[table] === undefined) continue;
      const retired = String(directionRetirements[table] ?? "0");
      if (!/^\d+$/.test(retired) || BigInt(retired) > BigInt(sourceCounts[table])) {
        throw new Error("Invalid stopped-source direction retirement count: " + table);
      }
      adjustedCounts[table] = String(BigInt(sourceCounts[table]) - BigInt(retired));
      if (BigInt(retired) > 0n) {
        retiredDerivedRows.push({ table, retired, reason: "no canonical crop binding" });
      }
    }
  }
  return {
    losses: [...unexpectedRetained, ...compareMinimumCounts(adjustedCounts, targetCounts)],
    retiredDerivedRows,
  };
}

function pgBoolean(value) {
  if (value === "t" || value === "true") return true;
  if (value === "f" || value === "false") return false;
  throw new Error("Invalid native identity schema attestation");
}

export async function nativeIdentityInstalled(query, counts) {
  if (!Object.hasOwn(counts, "schema_migrations")) return false;
  const marker = pgBoolean(await query(
    "SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '" + NATIVE_REID_MIGRATION + "');"
  ));
  if (!marker) return false;
  if (!Object.hasOwn(counts, "vehicle_reid_control")) throw new Error("Native identity control is missing");
  const control = pgBoolean(await query(
    "SELECT count(*) = 1 FROM public.vehicle_reid_control WHERE singleton AND mode = 'v2_primary';"
  ));
  if (!control) throw new Error("Native identity authority control is invalid");
  return true;
}

// Capture before the dump with the application stopped. No guessed loss budget:
// Blue Iris observations and canonical-bound direction examples stay protected.
export async function captureNativeUpgradeSnapshot(query, counts) {
  const native = await nativeIdentityInstalled(query, counts);
  const directionRetirements = {};
  if (!native) {
    for (const [table, predicate] of Object.entries(RETIRED_DIRECTION_PREDICATES)) {
      if (!Object.hasOwn(counts, table)) continue;
      const boundColumn = pgBoolean(await query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '"
          + table + "' AND column_name = 'source_embedding_id');"
      ));
      const retired = await query("SELECT count(*) FROM public." + table + " WHERE " + predicate
        + (boundColumn ? " AND source_embedding_id IS NULL" : "") + ";");
      if (!/^\d+$/.test(retired) || BigInt(retired) > BigInt(counts[table])) {
        throw new Error("Invalid stopped-source direction retirement count: " + table);
      }
      directionRetirements[table] = retired;
    }
  }
  return { formatVersion: 1, native, directionRetirements };
}

export function compareSavedNativeUpgradeCounts(before, after, snapshot, targetNative) {
  if (snapshot?.formatVersion !== 1 || typeof snapshot.native !== "boolean"
      || !snapshot.directionRetirements || typeof snapshot.directionRetirements !== "object"
      || Array.isArray(snapshot.directionRetirements)
      || Object.keys(snapshot.directionRetirements).some((table) => !Object.hasOwn(RETIRED_DIRECTION_PREDICATES, table))) {
    throw new Error("This update was started by an older updater without native retirement evidence. Keep the backup; use the documented rollback and maintenance-launcher retry.");
  }
  if (!targetNative) throw new Error("Updated database lacks the completed native ReID schema and authority control");
  return compareNativeUpgradeCounts(before, after, {
    sourceNative: snapshot.native, targetNative, directionRetirements: snapshot.directionRetirements,
  });
}
