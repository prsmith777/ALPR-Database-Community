// Reproduce the current-assignment/member contract as one snapshot-local set.
// Do not expand current members once per assignment: that repeats pair-review
// evidence validation thousands of times. Include ALL members of each relevant
// canonical profile, not just page members, so off-page conflicts still veto it.
export const PRIMARY_PLATE_READ_IDENTITY_SQL = `
      WITH candidate_assignments AS MATERIALIZED (
        SELECT historical.*
        FROM public.vehicle_reid_v2_read_assignments historical
        WHERE historical.read_id = ANY($1::bigint[]) AND historical.status = 'active'
      ), merge_candidates AS MATERIALIZED (
        SELECT id FROM public.vehicle_reid_v2_profile_merges WHERE status = 'current'
      ), exact_merges AS MATERIALIZED (
        SELECT exact_merge.source_profile_id, exact_merge.target_profile_id
        FROM merge_candidates candidate
        JOIN LATERAL (
          SELECT source_profile_id, target_profile_id
          FROM public.vehicle_reid_v2_current_profile_merges
          WHERE id = candidate.id
          OFFSET 0
        ) exact_merge ON TRUE
      ), member_profiles AS MATERIALIZED (
        SELECT DISTINCT COALESCE(merges.target_profile_id, assignments.profile_id) AS id
        FROM candidate_assignments assignments
        LEFT JOIN exact_merges merges ON merges.source_profile_id = assignments.profile_id
        WHERE assignments.assignment_basis IN ('canonical_image','shared_asset','human_same')
      ), source_profiles AS MATERIALIZED (
        SELECT id FROM member_profiles
        UNION
        SELECT merges.source_profile_id FROM exact_merges merges
        JOIN member_profiles profiles ON profiles.id = merges.target_profile_id
      ), member_candidates AS MATERIALIZED (
        SELECT members.id
        FROM public.vehicle_reid_v2_profile_members members
        JOIN source_profiles profiles ON profiles.id = members.profile_id
        WHERE members.status = 'current'
      ), exact_members AS MATERIALIZED (
        SELECT members.*,
               COALESCE(merges.target_profile_id, members.profile_id) AS canonical_profile_id
        FROM member_candidates candidate
        JOIN LATERAL (
          SELECT * FROM public.vehicle_reid_v2_exact_profile_members
          WHERE id = candidate.id
          OFFSET 0
        ) members ON TRUE
        LEFT JOIN exact_merges merges ON merges.source_profile_id = members.profile_id
        JOIN member_profiles profiles
          ON profiles.id = COALESCE(merges.target_profile_id, members.profile_id)
      ), current_anchors AS MATERIALIZED (
        SELECT anchors.*,
               COALESCE(merges.target_profile_id, anchors.profile_id) AS canonical_profile_id
        FROM public.vehicle_reid_v2_profile_plate_anchors anchors
        JOIN public.plate_reads evidence ON evidence.id = anchors.evidence_read_id
        LEFT JOIN exact_merges merges ON merges.source_profile_id = anchors.profile_id
        JOIN public.vehicle_reid_v2_profiles profiles
          ON profiles.id = COALESCE(merges.target_profile_id, anchors.profile_id)
        WHERE anchors.status = 'current'
          AND profiles.status IN ('active','provisional')
          AND UPPER(REGEXP_REPLACE(evidence.plate_number, '[^A-Za-z0-9]', '', 'g'))
                = anchors.normalized_plate
          AND evidence.review_status = anchors.plate_review_status
          AND evidence.review_revision = anchors.plate_review_revision
          AND evidence.applied_alias_id IS NOT DISTINCT FROM anchors.applied_alias_id
          AND anchors.plate_review_id IS NOT DISTINCT FROM (
            SELECT reviews.id FROM public.plate_read_reviews reviews
            WHERE reviews.read_id = anchors.evidence_read_id
            ORDER BY reviews.created_at DESC, reviews.id DESC LIMIT 1
          )
      ), conflicting_anchor_members AS MATERIALIZED (
        SELECT DISTINCT members.id
        FROM exact_members members
        JOIN public.vehicle_image_asset_reads links ON links.asset_id = members.asset_id
        JOIN public.plate_reads reads ON reads.id = links.read_id
        JOIN current_anchors anchors
          ON anchors.normalized_plate = UPPER(REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g'))
        WHERE links.identity_eligible = TRUE
          AND links.relationship <> 'display_fallback'
          AND reads.vehicle_image_status = 'ready'
          AND reads.vehicle_image_path = links.source_path_snapshot
          AND reads.vehicle_image_source_kind = links.source_kind
          AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
          AND reads.review_status IN ('confirmed','corrected','alias_resolved')
          AND anchors.canonical_profile_id <> members.canonical_profile_id
      ), conflicting_review_profiles AS MATERIALIZED (
        SELECT DISTINCT low_member.canonical_profile_id
        FROM public.vehicle_reid_v2_pair_reviews reviews
        JOIN exact_members low_member ON low_member.derivative_id = reviews.derivative_id_low
        JOIN exact_members high_member ON high_member.derivative_id = reviews.derivative_id_high
        WHERE reviews.label IN ('different_vehicle','unsure')
          AND reviews.embedding_model = low_member.embedding_model
          AND reviews.embedding_model = high_member.embedding_model
          AND reviews.algorithm_version = low_member.embedding_algorithm_version
          AND reviews.algorithm_version = high_member.embedding_algorithm_version
          AND reviews.source_sha256_low = low_member.crop_content_sha256
          AND reviews.source_sha256_high = high_member.crop_content_sha256
          AND reviews.embedding_id_low = low_member.embedding_id
          AND reviews.embedding_id_high = high_member.embedding_id
          AND low_member.canonical_profile_id = high_member.canonical_profile_id
      ), current_members AS MATERIALIZED (
        SELECT members.* FROM exact_members members
        WHERE NOT EXISTS (SELECT 1 FROM conflicting_anchor_members conflicts WHERE conflicts.id = members.id)
          AND NOT EXISTS (SELECT 1 FROM conflicting_review_profiles conflicts
                          WHERE conflicts.canonical_profile_id = members.canonical_profile_id)
      ), current_assignments AS MATERIALIZED (
        SELECT assignments.*,
               COALESCE(merges.target_profile_id, assignments.profile_id) AS canonical_profile_id
        FROM candidate_assignments assignments
        JOIN public.vehicle_reid_v2_profiles source_profiles ON source_profiles.id = assignments.profile_id
        LEFT JOIN exact_merges merges ON merges.source_profile_id = assignments.profile_id
        JOIN public.vehicle_reid_v2_profiles canonical_profiles
          ON canonical_profiles.id = COALESCE(merges.target_profile_id, assignments.profile_id)
        JOIN public.plate_reads reads ON reads.id = assignments.read_id
        WHERE source_profiles.status IN ('active','provisional')
          AND canonical_profiles.status IN ('active','provisional')
          AND source_profiles.revision = assignments.profile_revision
          AND (
            (
              assignments.assignment_basis = 'exact_effective_plate'
              AND (assignments.origin_conversion_run_id IS NOT NULL
                   OR assignments.profile_membership_basis = 'exact_effective_plate')
              AND UPPER(REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g'))
                    = assignments.normalized_effective_plate
              AND reads.review_status = assignments.plate_review_status
              AND reads.review_revision = assignments.plate_review_revision
              AND reads.applied_alias_id IS NOT DISTINCT FROM assignments.applied_alias_id
              AND assignments.plate_review_id IS NOT DISTINCT FROM (
                SELECT reviews.id FROM public.plate_read_reviews reviews
                WHERE reviews.read_id = assignments.read_id
                ORDER BY reviews.created_at DESC, reviews.id DESC LIMIT 1
              )
              AND EXISTS (
                SELECT 1 FROM current_anchors anchors
                WHERE anchors.canonical_profile_id = COALESCE(merges.target_profile_id, assignments.profile_id)
                  AND anchors.normalized_plate = assignments.normalized_effective_plate
              )
            ) OR (
              assignments.assignment_basis IN ('canonical_image','shared_asset','human_same')
              AND EXISTS (
                SELECT 1 FROM current_members members
                JOIN public.vehicle_image_asset_reads links
                  ON links.asset_id = members.asset_id AND links.read_id = assignments.read_id
                WHERE members.id = assignments.profile_member_id
                  AND members.profile_id = assignments.profile_id
                  AND members.asset_id = assignments.asset_id
                  AND members.derivative_id = assignments.derivative_id
                  AND members.embedding_id = assignments.embedding_id
                  AND members.membership_basis = assignments.profile_membership_basis
                  AND members.canonical_profile_id = COALESCE(merges.target_profile_id, assignments.profile_id)
                  AND links.identity_eligible = TRUE
                  AND links.relationship <> 'display_fallback'
                  AND links.source_kind IS NOT DISTINCT FROM assignments.source_kind
                  AND links.relationship IS NOT DISTINCT FROM assignments.source_relationship
                  AND links.source_path_snapshot IS NOT DISTINCT FROM assignments.source_path_snapshot
                  AND links.source_updated_at IS NOT DISTINCT FROM assignments.source_updated_at
                  AND links.updated_at IS NOT DISTINCT FROM assignments.source_link_updated_at
                  AND reads.vehicle_image_status = 'ready'
                  AND reads.vehicle_image_path = links.source_path_snapshot
                  AND reads.vehicle_image_source_kind = links.source_kind
                  AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
              )
            )
          )
      )
      SELECT pr.id AS read_id, assignment.canonical_profile_id,
             assignment.assignment_basis, (search.derivative_id IS NOT NULL) AS searchable
      FROM public.plate_reads pr
      LEFT JOIN LATERAL (
        SELECT * FROM current_assignments WHERE read_id = pr.id ORDER BY id DESC LIMIT 1
      ) assignment ON TRUE
      LEFT JOIN LATERAL (
        SELECT derivatives.id AS derivative_id
        FROM public.vehicle_image_asset_reads links
        JOIN public.vehicle_image_derivatives derivatives
          ON derivatives.asset_id = links.asset_id
         AND derivatives.derivative_kind = 'vehicle_crop'
         AND derivatives.algorithm_version = 'canonical-overview-detection-box-v1'
        JOIN public.vehicle_asset_embeddings embeddings
          ON embeddings.derivative_id = derivatives.id
         AND embeddings.model_name = 'vehicle-reid-0001-ir-fp16-v1'
         AND embeddings.algorithm_version = 'canonical-overview-crop-embedding-v1'
         AND embeddings.source_sha256 = derivatives.content_sha256
        WHERE links.read_id = pr.id
          AND links.identity_eligible = TRUE
          AND links.relationship <> 'display_fallback'
          AND pr.vehicle_image_status = 'ready'
          AND pr.vehicle_image_path = links.source_path_snapshot
          AND pr.vehicle_image_source_kind = links.source_kind
          AND pr.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
        LIMIT 1
      ) search ON TRUE
      WHERE pr.id = ANY($1::bigint[])
    `;

export async function hydratePlateReadVehicleIdentity(client, rows) {
  if (rows.length === 0) return rows;
  const control = await client.query("SELECT mode FROM public.vehicle_reid_control WHERE singleton = TRUE");
  const mode = control.rows[0]?.mode;
  if (!["v1_primary", "v1_rollback", "v2_shadow", "v2_primary"].includes(mode)) {
    throw new Error("Vehicle identity authority mode unavailable");
  }
  const ids = rows.map((row) => row.id);
  let identities;
  if (mode === "v2_primary") {
    identities = await client.query(PRIMARY_PLATE_READ_IDENTITY_SQL, [ids]);
  } else {
    identities = await client.query(`
      SELECT read_id, cluster_id, assignment_status, similarity
      FROM public.vehicle_cluster_assignments WHERE read_id = ANY($1::bigint[])
    `, [ids]);
  }
  const byId = new Map(identities.rows.map((row) => [String(row.read_id), row]));
  return rows.map((row) => {
    const identity = byId.get(String(row.id));
    const primary = mode === "v2_primary";
    const profile = primary ? identity?.canonical_profile_id ?? null : null;
    return {
      ...row,
      vehicle_identity_mode: mode,
      vehicle_cluster_id: primary ? profile : identity?.cluster_id ?? null,
      vehicle_cluster_status: primary ? (profile ? "authoritative" : null) : identity?.assignment_status ?? null,
      vehicle_cluster_similarity: primary ? null : identity?.similarity ?? null,
      vehicle_profile_id: profile,
      vehicle_profile_assignment_basis: primary ? identity?.assignment_basis ?? null : null,
      vehicle_find_similar_available: primary ? identity?.searchable === true : true,
    };
  });
}
