import { getPool } from "@/lib/db";
import { publicInput } from "@/lib/camera-inputs/config.mjs";
import { CameraInputRepository } from "@/lib/camera-inputs/repository.mjs";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

export async function GET(_request, { params }) {
  const denied = await denyUnlessRoutePermission("system.manage_settings");
  if (denied) return denied;
  const { id } = await params;
  try {
    const pool = await getPool();
    const result = await pool.query(
      `SELECT events.id,events.status,events.received_at,events.transport,
      events.payload - 'image' - 'sceneImage' AS event,
      CASE WHEN passages.last_event_id=events.id THEN reads.thumbnail_path END AS thumbnail_path,
      CASE WHEN passages.last_event_id=events.id THEN reads.image_path END AS image_path,
      CASE WHEN passages.last_event_id=events.id THEN passages.scene_image_path END AS scene_image_path,
      CASE WHEN passages.last_event_id=events.id THEN passages.scene_thumbnail_path END AS scene_thumbnail_path
      FROM public.camera_input_events events LEFT JOIN public.plate_reads reads ON reads.id=events.read_id
      LEFT JOIN public.camera_input_passages passages ON passages.id=events.passage_id
      WHERE events.input_id=$1 ORDER BY events.id DESC LIMIT 5`,
      [id],
    );
    const input = publicInput(await new CameraInputRepository(pool).get(id));
    return Response.json(
      { events: result.rows, input },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Unable to load recent events" },
      { status: 503 },
    );
  }
}
