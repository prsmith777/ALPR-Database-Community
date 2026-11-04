import { randomUUID } from "node:crypto";
import {
  hashCredential,
  newCredential,
  publicInput,
  validateInput,
} from "./config.mjs";
import { InputError, normalizeAxisEvent, text } from "./axis.mjs";

export class CameraInputRepository {
  constructor(pool) {
    this.pool = pool;
  }
  async get(id) {
    return (
      (
        await this.pool.query(
          "SELECT * FROM public.camera_inputs WHERE id = $1 AND deleted_at IS NULL",
          [id],
        )
      ).rows[0] ?? null
    );
  }
  async list() {
    // Existing camera names remain valid and require no enrollment or rewrite.
    const configured = (
      await this.pool.query(`SELECT inputs.*, brokers.name AS broker_name,
      (SELECT COUNT(*)::int FROM public.camera_input_events events WHERE events.input_id = inputs.id AND events.status = 'pending') AS pending_count
      FROM public.camera_inputs inputs LEFT JOIN public.mqttbrokers brokers ON brokers.id = inputs.broker_id ORDER BY inputs.camera_name`)
    ).rows.map(publicInput);
    const legacy = (
      await this.pool
        .query(`SELECT camera_name, MAX(timestamp) AS last_received_at FROM public.plate_reads
      WHERE NULLIF(BTRIM(camera_name), '') IS NOT NULL GROUP BY camera_name`)
    ).rows;
    const names = new Set(
      configured.map((input) => input.camera_name.trim().toLowerCase()),
    );
    return [
      ...configured.filter((input) => !input.deleted_at),
      ...legacy
        .filter((row) => !names.has(row.camera_name.trim().toLowerCase()))
        .map((row) => ({
          ...row,
          id: null,
          source: "blue_iris",
          transport: "http",
          enabled: true,
          legacy: true,
        })),
    ];
  }
  async save(data, id = null) {
    const initial = id ? await this.get(id) : null;
    if (id && !initial) throw new InputError("Camera input not found", 404);
    const candidate = validateInput(data, initial);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Match the legacy ingestion gate, including a camera not registered yet.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(LOWER(BTRIM($1)),1))",
        [candidate.camera_name],
      );
      const previous = id
        ? (
            await client.query(
              "SELECT * FROM public.camera_inputs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
              [id],
            )
          ).rows[0]
        : null;
      if (id && !previous) throw new InputError("Camera input not found", 404);
      const input = id ? validateInput(data, previous) : candidate;
      if (previous && input.camera_name !== previous.camera_name)
        throw new InputError(
          "Camera names are permanent; create another input to use a different name",
        );
      if (
        previous &&
        (input.source !== previous.source ||
          input.device_id !== previous.device_id ||
          input.processing_mode !== previous.processing_mode)
      ) {
        const pending = await client.query(
          "SELECT 1 FROM public.camera_input_events WHERE input_id = $1 AND status = 'pending' UNION ALL SELECT 1 FROM public.camera_input_passages WHERE input_id=$1 AND read_id IS NULL AND NOT finalized LIMIT 1",
          [id],
        );
        if (pending.rows.length)
          throw new InputError(
            "Allow pending events and passages to finish before changing camera identity or processing mode",
            409,
          );
      }
      const credential =
        input.source === "axis" &&
        input.transport !== "mqtt" &&
        (!previous?.credential_hash || data.rotate_credential === true)
          ? newCredential()
          : null;
      const result = await client.query(
        `INSERT INTO public.camera_inputs
      (id, camera_name, source, transport, enabled, device_id, broker_id, topic_filter, qos, processing_mode, store_images, direction_in, direction_out, credential_hash, roi_filter)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(id) DO UPDATE SET source=EXCLUDED.source, transport=EXCLUDED.transport, enabled=EXCLUDED.enabled,
        device_id=EXCLUDED.device_id, broker_id=EXCLUDED.broker_id, topic_filter=EXCLUDED.topic_filter, qos=EXCLUDED.qos,
        processing_mode=EXCLUDED.processing_mode, store_images=EXCLUDED.store_images, direction_in=EXCLUDED.direction_in,
        direction_out=EXCLUDED.direction_out, credential_hash=EXCLUDED.credential_hash, roi_filter=EXCLUDED.roi_filter, updated_at=CURRENT_TIMESTAMP
      RETURNING *`,
        [
          input.id,
          input.camera_name,
          input.source,
          input.transport,
          input.enabled,
          input.device_id,
          input.broker_id,
          input.topic_filter,
          input.qos,
          input.processing_mode,
          input.store_images,
          input.direction_in,
          input.direction_out,
          credential
            ? hashCredential(credential)
            : (previous?.credential_hash ?? null),
          input.roi_filter,
        ],
      );
      await client.query("COMMIT");
      return {
        input: publicInput(result.rows[0]),
        ...(credential ? { credential } : {}),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async remove(data) {
    let id = data.id == null ? null : text(data.id, 36);
    if (id && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
      throw new InputError("Invalid camera input ID");
    const initial = id
      ? (await this.pool.query("SELECT id,camera_name FROM public.camera_inputs WHERE id=$1", [id])).rows[0]
      : null;
    if (id && !initial) throw new InputError("Camera input not found", 404);
    const name = initial?.camera_name ?? text(data.camera_name, 30);
    if (!name) throw new InputError("Camera name is required");
    if (initial && data.camera_name != null && text(data.camera_name, 30) !== name)
      throw new InputError("Camera input changed; reload before deleting it", 409);
    // PostgreSQL normalizes UUID spelling; use that same identity for locks.
    id = initial?.id ?? null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended(LOWER(BTRIM($1)),1))", [name]);
      // Workers hold a shared session lock across their ingestion transaction.
      // Wait before locking the input row so their completion cannot deadlock.
      if (id)
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,2))", [id]);
      let input = (await client.query(
        id
          ? "SELECT * FROM public.camera_inputs WHERE id=$1 FOR UPDATE"
          : `SELECT * FROM public.camera_inputs WHERE LOWER(BTRIM(camera_name))=LOWER(BTRIM($1))
             ORDER BY (deleted_at IS NULL) DESC,deleted_at DESC LIMIT 1 FOR UPDATE`,
        [id ?? name],
      )).rows[0];
      if (id && !input) throw new InputError("Camera input not found", 404);
      if (!id && input && !input.deleted_at)
        throw new InputError("Camera input changed; reload before deleting it", 409);
      if (input?.deleted_at) {
        await client.query("COMMIT");
        return { deleted: true, id: input.id, camera_name: name, already_deleted: true };
      }
      if (!input) {
        const legacy = await client.query(
          "SELECT 1 FROM public.plate_reads WHERE LOWER(BTRIM(camera_name))=LOWER(BTRIM($1)) LIMIT 1", [name],
        );
        if (!legacy.rows.length) throw new InputError("Camera input not found", 404);
        input = (await client.query(
          `INSERT INTO public.camera_inputs(id,camera_name,source,transport,enabled)
           VALUES ($1,$2,'blue_iris','http',FALSE) RETURNING *`, [randomUUID(), name],
        )).rows[0];
      }
      const pending = (await client.query(
        "SELECT COUNT(*)::int AS count FROM public.camera_input_events WHERE input_id=$1 AND status='pending'", [input.id],
      )).rows[0].count;
      await client.query(
        `UPDATE public.camera_input_events SET status=CASE WHEN status='pending' THEN 'ignored' ELSE status END,
         payload=payload - 'image' - 'sceneImage',leased_until=NULL,lease_token=NULL,
         processed_at=COALESCE(processed_at,CURRENT_TIMESTAMP) WHERE input_id=$1`, [input.id],
      );
      await client.query("UPDATE public.camera_input_passages SET finalized=TRUE WHERE input_id=$1", [input.id]);
      await client.query(
        `UPDATE public.camera_inputs SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,
         enabled=FALSE,credential_hash=NULL,broker_id=NULL,topic_filter=NULL,transport='http',
         connection_status='deleted',last_error=NULL WHERE id=$1`, [input.id],
      );
      await client.query("COMMIT");
      return { deleted: true, id: input.id, camera_name: name, discarded_events: pending };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async receive(input, payload, transport, { retained = false } = {}) {
    if (
      !input?.enabled ||
      input.source !== "axis" ||
      ![transport, "both"].includes(input.transport)
    )
      throw new InputError(
        "Camera input is disabled or does not accept this transport",
        403,
      );
    if (retained)
      throw new InputError(
        "Retained messages are not imported as new detections",
      );
    const event = normalizeAxisEvent(payload, input);
    if (input.roi_filter && input.roi_filter !== event.roi)
      return { filtered: true, duplicate: false, eventId: null };
    if (JSON.stringify(event).length > 32 * 1024 * 1024)
      throw new InputError("Event is too large", 413);
    const result = await this.pool.query(
      `WITH active AS (
      SELECT * FROM public.camera_inputs WHERE id=$1 AND enabled AND deleted_at IS NULL AND source='axis'
        AND device_id=$5 AND transport IN ($4,'both') AND (roi_filter IS NULL OR roi_filter=$6) FOR UPDATE
    ), event AS (
      INSERT INTO public.camera_input_events(input_id,fingerprint,payload,transport)
      SELECT $1,$2,CASE WHEN active.store_images THEN $3::jsonb ELSE $3::jsonb - 'image' - 'sceneImage' - 'imageDigest' - 'sceneDigest' END,$4 FROM active
      ON CONFLICT(input_id,fingerprint) DO UPDATE SET
        payload=public.camera_input_events.payload || jsonb_strip_nulls(jsonb_build_object(
          'image',CASE WHEN public.camera_input_events.payload->>'imageDigest' IS NULL THEN EXCLUDED.payload->'image' END,
          'imageDigest',CASE WHEN public.camera_input_events.payload->>'imageDigest' IS NULL THEN EXCLUDED.payload->'imageDigest' END,
          'sceneImage',CASE WHEN public.camera_input_events.payload->>'sceneDigest' IS NULL THEN EXCLUDED.payload->'sceneImage' END,
          'sceneDigest',CASE WHEN public.camera_input_events.payload->>'sceneDigest' IS NULL THEN EXCLUDED.payload->'sceneDigest' END)),
        status='pending',revision=public.camera_input_events.revision+1,next_attempt_at=CURRENT_TIMESTAMP
      WHERE public.camera_input_events.status<>'ignored' AND (
        (public.camera_input_events.payload->>'imageDigest' IS NULL AND EXCLUDED.payload->>'imageDigest' IS NOT NULL) OR
        (public.camera_input_events.payload->>'sceneDigest' IS NULL AND EXCLUDED.payload->>'sceneDigest' IS NOT NULL))
      RETURNING id,(xmax=0) AS inserted
    ), seen AS (
      UPDATE public.camera_inputs SET last_received_at=CURRENT_TIMESTAMP,last_error=NULL,connection_status='receiving' WHERE id IN(SELECT id FROM active)
    ) SELECT (SELECT id FROM event) AS id,(SELECT inserted FROM event) AS inserted,EXISTS(SELECT 1 FROM active) AS active`,
      [
        input.id,
        event.fingerprint,
        JSON.stringify(event),
        transport,
        event.camera,
        event.roi,
      ],
    );
    const row = result.rows[0];
    if (!row.active)
      throw new InputError(
        "Camera configuration changed; retry with the current configuration",
        403,
      );
    return { duplicate: row.inserted !== true, eventId: row.id ?? null };
  }

  async status(id, status, error = null) {
    await this.pool.query(
      "UPDATE public.camera_inputs SET connection_status=$2, last_error=$3 WHERE id=$1 AND deleted_at IS NULL",
      [id, status, error],
    );
  }
  async mqttInputs() {
    return (
      await this.pool
        .query(`SELECT inputs.*, brokers.broker, brokers.port, brokers.username, brokers.password, brokers.use_tls, brokers.enabled AS broker_enabled
      FROM public.camera_inputs inputs JOIN public.mqttbrokers brokers ON brokers.id = inputs.broker_id
      WHERE inputs.source='axis' AND inputs.enabled AND inputs.deleted_at IS NULL AND inputs.transport IN ('mqtt','both')`)
    ).rows;
  }
  async claim() {
    return (
      (
        await this.pool.query(
          `UPDATE public.camera_input_events SET leased_until=CURRENT_TIMESTAMP + INTERVAL '2 minutes', lease_token=$1
      WHERE id=(SELECT id FROM public.camera_input_events WHERE status='pending' AND next_attempt_at<=CURRENT_TIMESTAMP
        AND (leased_until IS NULL OR leased_until<CURRENT_TIMESTAMP) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
          [randomUUID()],
        )
      ).rows[0] ?? null
    );
  }
  async fail(event) {
    // Retry durable events without a finite loss-inducing retry limit.
    await this.pool.query(
      `UPDATE public.camera_input_events SET attempts=attempts+1, leased_until=NULL,
      next_attempt_at=CURRENT_TIMESTAMP + LEAST(300, 5 * (attempts+1)) * INTERVAL '1 second'
      WHERE id=$1 AND lease_token=$2 AND status='pending'`,
      [event.id, event.lease_token],
    );
    await this.status(
      event.input_id,
      "error",
      "Event processing failed; retry scheduled. See application logs.",
    );
  }
}
