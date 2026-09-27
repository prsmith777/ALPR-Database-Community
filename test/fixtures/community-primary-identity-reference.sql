-- Community 0.1.41 primary identity semantics, kept for equivalence tests.
-- Only page read IDs are parameterized; fixture data is synthetic.
SELECT pr.id AS read_id, reid_v2_assignment.canonical_profile_id,
       reid_v2_assignment.assignment_basis,
       (reid_v2_search.derivative_id IS NOT NULL) AS searchable
FROM public.plate_reads pr
LEFT JOIN LATERAL (
        SELECT assignments.*
        FROM public.vehicle_reid_v2_current_read_assignments assignments
        WHERE assignments.read_id = pr.id
        LIMIT 1
      ) reid_v2_assignment ON TRUE
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
      ) reid_v2_search ON TRUE
WHERE pr.id = ANY($1::bigint[])
