import { randomUUID } from "node:crypto";

export function axisDirection(input, event) {
  const label =
    event.direction === "in"
      ? input.direction_in
      : event.direction === "out"
        ? input.direction_out
        : null;
  return label
    ? {
        status: "ready",
        directionLabel: label,
        orientation: ["front", "rear"].includes(event.metadata.vehicle.view)
          ? event.metadata.vehicle.view
          : "unknown",
        confidence: null,
        source: "axis_license_plate_verifier",
        classifierVersion: "axis-lpv-direction-v1",
      }
    : null;
}
export async function persistAxisDirection(query, readId, camera, observation) {
  if (!observation) return;
  await query(
    `INSERT INTO public.vehicle_direction_observations
    (read_id,camera_key,embedding_model,classifier_version,profile_version,status,orientation,orientation_confidence,direction_label,sample_counts)
    VALUES ($1,LOWER(BTRIM($2)),'axis-lpv','axis-lpv-direction-v1',1,'ready',$3,NULL,$4,$5::jsonb)
    ON CONFLICT(read_id) DO UPDATE SET status=EXCLUDED.status,orientation=EXCLUDED.orientation,
      orientation_confidence=NULL,direction_label=EXCLUDED.direction_label,sample_counts=EXCLUDED.sample_counts,
      classifier_version=EXCLUDED.classifier_version,embedding_model=EXCLUDED.embedding_model,source_embedding_id=NULL,evaluated_at=CURRENT_TIMESTAMP`,
    [
      readId,
      camera,
      observation.orientation,
      observation.directionLabel,
      JSON.stringify({ source: observation.source }),
    ],
  );
}

export class AxisEventProcessor {
  constructor({
    pool,
    ingest,
    storage,
    publish = () => {},
    notifyDirection = async () => {},
    logger = console,
  }) {
    this.pool = pool;
    this.ingest = ingest;
    this.storage = storage;
    this.publish = publish;
    this.notifyDirection = notifyDirection;
    this.logger = logger;
  }
  async process(receipt, { finalize = false } = {}) {
    const client = await this.pool.connect();
    let lockKey;
    let locked = false;
    let transaction = false;
    let committed = false;
    const files = [];
    try {
      const event = receipt.payload;
      lockKey = `${receipt.input_id}:${event.carId}`;
      locked = (
        await client.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
          [lockKey],
        )
      ).rows[0].locked;
      if (!locked) return false;
      const input = (
        await client.query("SELECT * FROM public.camera_inputs WHERE id=$1", [
          receipt.input_id,
        ])
      ).rows[0];
      if (!input?.enabled || input.source !== "axis") return false;
      const current = (
        await client.query(
          "SELECT status FROM public.camera_input_events WHERE id=$1",
          [receipt.id],
        )
      ).rows[0];
      if (!current || (current.status !== "pending" && !finalize)) return true;
      let passage = (
        await client.query(
          `SELECT * FROM public.camera_input_passages WHERE input_id=$1 AND car_id=$2 AND source_camera=$4
        AND first_capture <= $3::timestamptz + INTERVAL '30 seconds' AND last_capture >= $3::timestamptz - INTERVAL '30 minutes'
        ORDER BY (first_capture <= $3::timestamptz) DESC, first_capture DESC LIMIT 1`,
          [input.id, event.carId, event.timestamp, event.camera],
        )
      ).rows[0];
      if (
        passage &&
        event.state === "new" &&
        new Date(event.timestamp) > new Date(passage.last_capture)
      )
        passage = null;
      if (!passage) {
        passage = (
          await client.query(
            `INSERT INTO public.camera_input_passages(id,input_id,car_id,first_capture,last_capture,last_event_id,last_state,source_camera)
          VALUES ($1,$2,$3,$4,$4,$5,$6,$7) RETURNING *`,
            [
              randomUUID(),
              input.id,
              event.carId,
              event.timestamp,
              receipt.id,
              event.state,
              event.camera,
            ],
          )
        ).rows[0];
      }
      const isLatest =
        event.state === "lost" ||
        (passage.last_state !== "lost" &&
          new Date(event.timestamp) >= new Date(passage.last_capture));
      const direction = axisDirection(input, event);
      const finish = async (query, readId, ignored = false) => {
        // Receivers lock the input before the receipt; keep the same order.
        await query(
          "SELECT id FROM public.camera_inputs WHERE id=$1 FOR UPDATE",
          [input.id],
        );
        await query(
          `UPDATE public.camera_input_events SET status=CASE WHEN revision=$4 THEN $2 ELSE 'pending' END,read_id=$3,processed_at=CURRENT_TIMESTAMP,leased_until=NULL,
          payload=CASE WHEN revision=$4 THEN payload - 'image' - 'sceneImage' ELSE payload END WHERE id=$1`,
          [
            receipt.id,
            ignored ? "ignored" : "processed",
            readId,
            receipt.revision ?? 0,
          ],
        );
        await query(
          `UPDATE public.camera_input_passages SET read_id=COALESCE(read_id,$2),
          first_capture=LEAST(first_capture,$3::timestamptz),last_capture=GREATEST(last_capture,$3::timestamptz),
          last_event_id=CASE WHEN $4 THEN $5 ELSE last_event_id END,last_state=CASE WHEN $4 THEN $6 ELSE last_state END,
          direction_label=CASE WHEN $4 THEN COALESCE($7,direction_label) ELSE direction_label END,
          finalized=finalized OR $8,last_seen=CURRENT_TIMESTAMP WHERE id=$1`,
          [
            passage.id,
            readId,
            event.timestamp,
            isLatest,
            receipt.id,
            event.state,
            direction?.directionLabel ?? null,
            event.state === "lost" || finalize || ignored,
          ],
        );
        await query(
          "UPDATE public.camera_inputs SET last_imported_at=CURRENT_TIMESTAMP,last_error=NULL,connection_status='receiving' WHERE id=$1",
          [input.id],
        );
      };
      if (
        !passage.read_id &&
        input.processing_mode === "final" &&
        event.state !== "lost" &&
        !finalize
      ) {
        // Retain the latest pending image until LOST or the inactivity fallback.
        await client.query(
          `UPDATE public.camera_input_passages SET first_capture=LEAST(first_capture,$2::timestamptz),last_capture=GREATEST(last_capture,$2::timestamptz),
          last_event_id=CASE WHEN $3 THEN $4 ELSE last_event_id END,last_state=CASE WHEN $3 THEN $5 ELSE last_state END,last_seen=CURRENT_TIMESTAMP WHERE id=$1`,
          [passage.id, event.timestamp, isLatest, receipt.id, event.state],
        );
        await client.query(
          "UPDATE public.camera_input_events SET status='processed',processed_at=CURRENT_TIMESTAMP,leased_until=NULL WHERE id=$1",
          [receipt.id],
        );
        return true;
      }
      if (!passage.read_id) {
        const thisStorage = this.storage;
        const response = await this.ingest(
          {
            plate_number: event.plate,
            camera: input.camera_name,
            timestamp: new Date(passage.first_capture).toISOString(),
            Image: input.store_images ? event.image : null,
          },
          null,
          {
            axisEvent: event,
            axisDirection: direction,
            eventIdentity: `axis-passage:${passage.id}`,
            async onAcceptedRead(query, readId, trackImage) {
              if (event.sceneImage && input.store_images) {
                const scene = await thisStorage.saveImage(
                  event.sceneImage,
                  event.plate,
                );
                trackImage(scene);
                await query(
                  "UPDATE public.camera_input_passages SET scene_image_path=$2,scene_thumbnail_path=$3 WHERE id=$1",
                  [passage.id, scene.imagePath, scene.thumbnailPath],
                );
              }
              await persistAxisDirection(
                query,
                readId,
                input.camera_name,
                direction,
              );
              await finish(query, readId);
            },
          },
        );
        if (response.status >= 500) throw new Error("AXIS_INGESTION_FAILED");
        if (![201, 409].includes(response.status))
          throw new Error("AXIS_INGESTION_REJECTED");
        const body = await response.json();
        if (!body.processed?.length) {
          if (!body.ignored?.length) throw new Error("AXIS_READ_NOT_LINKED");
          await client.query("BEGIN");
          transaction = true;
          await finish((sql, values) => client.query(sql, values), null, true);
          await client.query("COMMIT");
          transaction = false;
        }
      } else {
        let savedImage = null;
        let scene = null;
        const existingImages = (
          await client.query(
            "SELECT image_path FROM public.plate_reads WHERE id=$1",
            [passage.read_id],
          )
        ).rows[0];
        if (
          (isLatest || !existingImages?.image_path) &&
          event.image &&
          input.store_images
        ) {
          savedImage = await this.storage.saveImage(event.image, event.plate);
          files.push(savedImage);
        }
        if (
          (isLatest || !passage.scene_image_path) &&
          event.sceneImage &&
          input.store_images
        ) {
          scene = await this.storage.saveImage(event.sceneImage, event.plate);
          files.push(scene);
        }
        await client.query("BEGIN");
        transaction = true;
        if (isLatest) {
          // Human review wins over later OCR. observed_plate remains immutable.
          await client.query(
            `INSERT INTO public.plates(plate_number) VALUES ($1) ON CONFLICT DO NOTHING`,
            [event.plate],
          );
          await client.query(
            `UPDATE public.plate_reads SET plate_number=CASE WHEN review_status='unreviewed' AND NOT validated THEN $2 ELSE plate_number END,
            confidence=$3,image_path=COALESCE($4,image_path),thumbnail_path=COALESCE($5,thumbnail_path)
            WHERE id=$1`,
            [
              passage.read_id,
              event.plate,
              event.confidence,
              savedImage?.imagePath ?? null,
              savedImage?.thumbnailPath ?? null,
            ],
          );
          await persistAxisDirection(
            (sql, values) => client.query(sql, values),
            passage.read_id,
            input.camera_name,
            direction,
          );
          if (direction)
            await this.notifyDirection(client, passage.read_id, direction);
        }
        if (scene)
          await client.query(
            "UPDATE public.camera_input_passages SET scene_image_path=$2,scene_thumbnail_path=$3 WHERE id=$1",
            [passage.id, scene.imagePath, scene.thumbnailPath],
          );
        if (!isLatest && savedImage)
          await client.query(
            "UPDATE public.plate_reads SET image_path=COALESCE(image_path,$2),thumbnail_path=COALESCE(thumbnail_path,$3) WHERE id=$1",
            [passage.read_id, savedImage.imagePath, savedImage.thumbnailPath],
          );
        await finish(
          (sql, values) => client.query(sql, values),
          passage.read_id,
        );
        await client.query("COMMIT");
        transaction = false;
        committed = true;
        this.publish([passage.read_id], "axis_updated");
      }
      return true;
    } catch (error) {
      if (transaction) await client.query("ROLLBACK").catch(() => {});
      if (!committed)
        await Promise.allSettled(
          files.map((file) =>
            this.storage.deleteImage(file.imagePath, file.thumbnailPath),
          ),
        );
      throw error;
    } finally {
      if (locked)
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey])
          .catch(() => {});
      client.release();
    }
  }
}
