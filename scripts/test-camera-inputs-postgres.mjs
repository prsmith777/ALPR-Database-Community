import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { CameraInputRepository } from "../lib/camera-inputs/repository.mjs";
import { CameraInputRuntime } from "../lib/camera-inputs/runtime.mjs";
import { AxisEventProcessor } from "../lib/camera-inputs/processor.mjs";

const serverUrl = process.env.ALPR_AXIS_TEST_SERVER_URL;
if (!serverUrl)
  throw new Error(
    "Set ALPR_AXIS_TEST_SERVER_URL to an isolated local PostgreSQL test server. Never use a production server.",
  );
const parsed = new URL(serverUrl);
if (!["127.0.0.1", "localhost"].includes(parsed.hostname))
  throw new Error("This validation script requires a local test server");
const admin = new pg.Pool({ connectionString: serverUrl });
const database = `alpr_axis_test_${process.pid}`;
const temporary = await mkdtemp(path.join(tmpdir(), "alpr-axis-integration-"));
let pool;
let applicationPool;
let created = false;
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  const testUrl = new URL(serverUrl);
  testUrl.pathname = `/${database}`;
  pool = new pg.Pool({ connectionString: testUrl.href });
  process.env.DB_HOST = `${testUrl.hostname}:${testUrl.port}`;
  process.env.DB_NAME = database;
  process.env.DB_USER = decodeURIComponent(testUrl.username || "postgres");
  process.env.DB_PASSWORD = "test-only";
  process.env.ALPR_CONFIG_FILE_PATH = path.join(temporary, "settings.yaml");
  process.env.ALPR_AUTH_FILE_PATH = path.join(temporary, "auth.json");
  process.env.STORAGE_PATH = path.join(temporary, "storage");
  process.env.ALPR_LOG_DIR = path.join(temporary, "logs");
  await pool.query(
    await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
  );
  await pool.query("SET search_path TO public");
  const migrations = await readFile(
    new URL("../migrations.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migrations);
  const [
    { processPlateRead, processCameraDirection },
    { default: storage },
    { getPool },
  ] = await Promise.all([
    import("../lib/plate-read-ingestion.js"),
    import("../lib/fileStorage.js"),
    import("../lib/db.js"),
  ]);
  applicationPool = await getPool();
  const png = await (
    await import("sharp")
  )
    .default({
      create: { width: 100, height: 32, channels: 3, background: "white" },
    })
    .jpeg()
    .toBuffer();
  const image = png.toString("base64");
  const body = (input, values = {}) => ({
    plateText: "ABC123",
    carID: "42",
    carState: "new",
    capture_timestamp: "1793286884000",
    carMoveDirection: "unknown",
    camera_info: { SerialNumber: input.device_id },
    plateConfidence: "0",
    imageType: "plate",
    ImageArray: [{ BinaryImage: image }],
    ...values,
  });
  const repository = new CameraInputRepository(pool);
  let ingestions = 0;
  let directionHandoffs = 0;
  const processor = new AxisEventProcessor({
    pool,
    storage,
    notifyDirection: (...args) => {
      directionHandoffs++;
      return processCameraDirection(...args);
    },
    ingest: (...args) => {
      ingestions++;
      return processPlateRead(...args);
    },
  });
  async function deliver(input, event, transport = "http") {
    const received = await repository.receive(input, event, transport);
    if (received.eventId) {
      const receipt = (
        await pool.query(
          "SELECT * FROM public.camera_input_events WHERE id=$1",
          [received.eventId],
        )
      ).rows[0];
      assert.equal(await processor.process(receipt), true);
    }
    return received;
  }
  const old = await processPlateRead({
    plate_number: "OLD123",
    camera: "Existing BI",
    timestamp: "2026-10-29T15:00:00.000Z",
  });
  assert.equal(old.status, 201);
  const before = (
    await pool.query(
      "SELECT * FROM public.plate_reads WHERE camera_name='Existing BI'",
    )
  ).rows[0];
  assert.equal(
    (await repository.list()).find((row) => row.camera_name === "Existing BI")
      .legacy,
    true,
  );
  const saved = await repository.save({
    camera_name: "Axis Test",
    source: "axis",
    transport: "both",
    device_id: "AABBCCDDEEFF",
    broker_id: await (async () => {
      const result = await pool.query(
        "INSERT INTO public.mqttbrokers(name,broker,port,topic) VALUES ('Test broker','127.0.0.1',1883,'test') RETURNING id",
      );
      return result.rows[0].id;
    })(),
    topic_filter: "axis/test/#",
  });
  const input = await repository.get(saved.input.id);
  assert.ok(saved.credential);
  assert.equal(saved.input.credential_hash, undefined);
  await deliver(input, body(input));
  assert.equal(ingestions, 1);
  const read = (
    await pool.query("SELECT * FROM public.plate_reads WHERE camera_name=$1", [
      input.camera_name,
    ])
  ).rows[0];
  assert.notEqual(read.confidence, null, "A reported zero is not missing confidence");
  assert.equal(Number(read.confidence), 0);
  assert.ok(read.image_path);
  // Exercise recovery through the duplicate branch of the shared ingestor.
  const initialReceipt = (await pool.query(
    "SELECT * FROM public.camera_input_events WHERE read_id=$1", [read.id],
  )).rows[0];
  await pool.query("UPDATE public.camera_input_passages SET read_id=NULL WHERE read_id=$1", [read.id]);
  await pool.query("UPDATE public.camera_input_events SET status='pending' WHERE id=$1", [initialReceipt.id]);
  let duplicateHook = 0;
  const recoveryProcessor = new AxisEventProcessor({ pool, storage,
    ingest: (data, request, context) => processPlateRead(data, request, {
      ...context,
      onAcceptedRead: async (query, id, trackImage) => {
        assert.equal(Number(id), read.id, "Duplicate hook receives the existing read ID");
        duplicateHook++;
        return context.onAcceptedRead(query, id, trackImage);
      },
    }),
  });
  assert.equal(await recoveryProcessor.process(initialReceipt), true);
  assert.equal(duplicateHook, 1);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM public.plate_reads WHERE camera_name=$1", [input.camera_name])).rows[0].count, 1);
  await deliver(
    input,
    body(input, {
      plateText: "ABC128",
      carState: "update",
      capture_timestamp: "1793286884500",
      carMoveDirection: "in",
    }),
  );
  const corrected = (
    await pool.query("SELECT * FROM public.plate_reads WHERE id=$1", [read.id])
  ).rows[0];
  assert.equal(corrected.plate_number, "ABC128");
  assert.equal(corrected.observed_plate, "ABC123");
  assert.equal(ingestions, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT direction_label FROM public.vehicle_direction_observations WHERE read_id=$1",
        [read.id],
      )
    ).rows[0].direction_label,
    "In",
  );
  await deliver(
    input,
    body(input, {
      plateText: "ABC123",
      carState: "new",
      capture_timestamp: "1793286884000",
    }),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT plate_number FROM public.plate_reads WHERE id=$1",
        [read.id],
      )
    ).rows[0].plate_number,
    "ABC128",
  );
  const mqttDuplicate = {
    topic: "axis:CameraApplicationPlatform/ALPV.AllPlates",
    message: {
      data: {
        text: "ABC128",
        carID: "42",
        carState: "update",
        capture_timestamp: "1793286884500",
        MACAddress: input.device_id,
        carMoveDirection: "in",
        lpImage: image,
      },
    },
  };
  assert.equal((await deliver(input, mqttDuplicate, "mqtt")).duplicate, true);
  await deliver(
    input,
    body(input, {
      plateText: "ABC128",
      carState: "lost",
      capture_timestamp: "1793286884500",
      carMoveDirection: "in",
    }),
  );
  await deliver(
    input,
    body(input, {
      plateText: "NEW123",
      carState: "new",
      capture_timestamp: "1793286885000",
    }),
  );
  assert.equal(
    ingestions,
    2,
    "A new runtime carID occurrence after LOST creates a new passage",
  );
  // A manual correction is authoritative over subsequent automatic OCR.
  await pool.query("INSERT INTO public.plates(plate_number) VALUES ('MANUAL')");
  await pool.query(
    "UPDATE public.plate_reads SET plate_number='MANUAL',review_status='corrected',validated=TRUE WHERE id=$1",
    [read.id],
  );
  const delayed = await deliver(
    input,
    body(input, {
      plateText: "LATE123",
      carState: "update",
      capture_timestamp: "1793286884600",
      carMoveDirection: "in",
    }),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT plate_number FROM public.plate_reads WHERE id=$1",
        [read.id],
      )
    ).rows[0].plate_number,
    "MANUAL",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT read_id FROM public.camera_input_events WHERE id=$1",
        [delayed.eventId],
      )
    ).rows[0].read_id,
    read.id,
    "Delayed observations remain attached to the earlier occurrence",
  );
  assert.ok(
    directionHandoffs > 0,
    "Direction arriving on UPDATE goes through the durable direction pipeline",
  );
  const finalSaved = await repository.save({
    camera_name: "Final Test",
    source: "axis",
    device_id: "112233445566",
    processing_mode: "final",
  });
  const finalInput = await repository.get(finalSaved.input.id);
  await deliver(finalInput, body(finalInput));
  await assert.rejects(
    () => repository.save({ device_id: "112233445577" }, finalInput.id),
    (error) => error.status === 409,
    "Buffered final-mode passages must finish before changing source identity",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::int AS count FROM public.plate_reads WHERE camera_name=$1",
        [finalInput.camera_name],
      )
    ).rows[0].count,
    0,
  );
  await deliver(
    finalInput,
    body(finalInput, {
      plateText: "FINAL12",
      carState: "lost",
      capture_timestamp: "1793286884700",
    }),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT plate_number FROM public.plate_reads WHERE camera_name=$1",
        [finalInput.camera_name],
      )
    ).rows[0].plate_number,
    "FINAL12",
  );
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS count FROM public.camera_input_events WHERE input_id=$1 AND
    (read_id IS NULL OR passage_id IS NULL OR payload ? 'image' OR payload ? 'sceneImage')`, [finalInput.id],
  )).rows[0].count, 0, "Final import links buffered receipts and removes their embedded images");
  await deliver(
    finalInput,
    body(finalInput, {
      carID: "77",
      plateText: "FALL123",
      capture_timestamp: "1793287994000",
    }),
  );
  await pool.query(
    "UPDATE public.camera_input_passages SET last_seen=CURRENT_TIMESTAMP-INTERVAL '31 seconds' WHERE input_id=$1 AND car_id='77'",
    [finalInput.id],
  );
  const staleCandidate = (await pool.query(
    `SELECT events.* FROM public.camera_input_passages passages JOIN public.camera_input_events events ON events.id=passages.last_event_id
    WHERE passages.input_id=$1 AND passages.car_id='77'`, [finalInput.id],
  )).rows[0];
  const queuedUpdate = await repository.receive(finalInput, body(finalInput, {
    carID: "77", plateText: "FALL128", carState: "update", capture_timestamp: "1793287994500",
  }), "http");
  await processor.process(staleCandidate, { finalize: true });
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM public.plate_reads WHERE plate_number IN ('FALL123','FALL128')",
  )).rows[0].count, 0, "A durable update still in the inbox prevents premature finalization");
  await processor.process((await pool.query(
    "SELECT * FROM public.camera_input_events WHERE id=$1", [queuedUpdate.eventId],
  )).rows[0]);
  await processor.process(staleCandidate, { finalize: true });
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS count FROM public.plate_reads WHERE plate_number IN ('FALL123','FALL128')",
  )).rows[0].count, 0, "A newer observation invalidates an old fallback candidate");
  await pool.query(
    "UPDATE public.camera_input_passages SET last_seen=CURRENT_TIMESTAMP-INTERVAL '31 seconds' WHERE input_id=$1 AND car_id='77'", [finalInput.id],
  );
  const runtime = new CameraInputRuntime({
    pool,
    storage,
    ingest: processPlateRead,
    mqttConnect: () => {
      throw new Error("Unexpected network");
    },
    logger: {},
  });
  runtime.repository.mqttInputs = async () => [];
  try {
    await runtime.tick();
  } finally {
    await runtime.stop();
  }
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::int AS count FROM public.plate_reads WHERE plate_number='FALL128'",
      )
    ).rows[0].count,
    1,
    "Final mode recovers when LOST is missing",
  );
  // A second transport adds an image while the first receipt is being processed.
  const sparse = body(input, {
    carID: "80",
    plateText: "ENRICH1",
    capture_timestamp: "1793288994000",
    ImageArray: [],
  });
  const sparseReceipt = await repository.receive(input, sparse, "http");
  const enrichment = {
    ...sparse,
    ImageArray: [
      { ImageType: "plate", BinaryImage: image },
      { ImageType: "vehicle", BinaryImage: image },
    ],
  };
  const enrichmentProcessor = new AxisEventProcessor({
    pool,
    storage,
    ingest: async (...args) => {
      const richer = await repository.receive(input, enrichment, "http");
      assert.equal(richer.duplicate, true);
      return processPlateRead(...args);
    },
  });
  await enrichmentProcessor.process(
    (
      await pool.query("SELECT * FROM public.camera_input_events WHERE id=$1", [
        sparseReceipt.eventId,
      ])
    ).rows[0],
  );
  const enrichedReceipt = (
    await pool.query("SELECT * FROM public.camera_input_events WHERE id=$1", [
      sparseReceipt.eventId,
    ])
  ).rows[0];
  assert.equal(
    enrichedReceipt.status,
    "pending",
    "A concurrent richer revision is not erased by the older worker",
  );
  await processor.process(enrichedReceipt);
  const enriched = (
    await pool.query(
      "SELECT reads.image_path,passages.scene_image_path FROM public.plate_reads reads JOIN public.camera_input_passages passages ON passages.read_id=reads.id WHERE reads.plate_number='ENRICH1'",
    )
  ).rows;
  assert.equal(enriched.length, 1);
  assert.ok(enriched[0].image_path);
  assert.ok(enriched[0].scene_image_path);
  const { storageReconciliationRepositoryInternals } = await import("../lib/storage-reconciliation-repository.mjs");
  const sceneReferences = await storageReconciliationRepositoryInternals.referencedPathSet(pool, [enriched[0].scene_image_path]);
  assert.ok(sceneReferences.has(enriched[0].scene_image_path.replaceAll("\\", "/")), "Stored Axis scenes are not classified as orphan files");
  assert.equal(
    (await repository.receive(input, enrichment, "http")).eventId,
    null,
    "Unchanged image redelivery does not enqueue work",
  );
  const filtered = await repository.save(
    { ...finalInput, roi_filter: "1" },
    finalInput.id,
  );
  assert.equal(
    (
      await repository.receive(
        await repository.get(filtered.input.id),
        body(finalInput, { roiID: "0" }),
        "http",
      )
    ).filtered,
    true,
  );
  const switched = await repository.save({
    camera_name: "Existing BI",
    source: "axis",
    device_id: "998877665544",
  });
  assert.equal(
    (await processPlateRead({ plate_number: "DUP123", camera: "Existing BI" }))
      .status,
    200,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::int AS count FROM public.plate_reads WHERE plate_number='DUP123'",
      )
    ).rows[0].count,
    0,
    "Only the explicitly chosen recognition source imports reads",
  );
  await repository.save({ source: "blue_iris" }, switched.input.id);
  await deliver(
    input,
    body(input, {
      carID: "100",
      plateText: "SAME123",
      capture_timestamp: "1793289994000",
    }),
  );
  await deliver(
    input,
    body(input, {
      carID: "101",
      plateText: "SAME123",
      capture_timestamp: "1793289994000",
    }),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::int AS count FROM public.plate_reads WHERE plate_number='SAME123'",
      )
    ).rows[0].count,
    2,
    "Distinct Axis passages remain distinct even at the same timestamp",
  );
  await deliver(
    input,
    body(input, {
      carID: "102",
      plateText: "EARLY12",
      capture_timestamp: "1793290994000",
    }),
  );
  await deliver(
    input,
    body(input, {
      carID: "102",
      plateText: "UPDATE1",
      carState: "update",
      capture_timestamp: "1793290994500",
    }),
  );
  await deliver(
    input,
    body(input, {
      carID: "102",
      plateText: "BEST123",
      carState: "lost",
      capture_timestamp: "1793290994000",
    }),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT plate_number FROM public.plate_reads WHERE observed_plate='EARLY12'",
      )
    ).rows[0].plate_number,
    "BEST123",
    "LOST is authoritative even when it reuses an earlier capture timestamp",
  );
  // Failure inside the shared transaction must leave the durable receipt pending.
  const failed = await repository.receive(
    input,
    body(input, {
      carID: "99",
      plateText: "RETRY12",
      capture_timestamp: "1793286994000",
    }),
    "http",
  );
  const receipt = (
    await pool.query("SELECT * FROM public.camera_input_events WHERE id=$1", [
      failed.eventId,
    ])
  ).rows[0];
  const broken = new AxisEventProcessor({
    pool,
    storage,
    ingest: (data, request, context) =>
      processPlateRead(data, request, {
        ...context,
        onAcceptedRead: async () => {
          throw new Error("Injected transaction failure");
        },
      }),
  });
  await assert.rejects(
    () => broken.process(receipt),
    /Injected transaction failure/,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::int AS count FROM public.plate_reads WHERE plate_number='RETRY12'",
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT status FROM public.camera_input_events WHERE id=$1",
        [receipt.id],
      )
    ).rows[0].status,
    "pending",
  );
  await processor.process(receipt);
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::int AS count FROM public.plate_reads WHERE plate_number='RETRY12'",
      )
    ).rows[0].count,
    1,
  );
  const replaced = await repository.save(
    { device_id: "C00000000001" },
    input.id,
  );
  const replacedInput = await repository.get(replaced.input.id);
  await deliver(
    replacedInput,
    body(replacedInput, {
      plateText: "DEVICE1",
      carState: "update",
      capture_timestamp: "1793286884500",
    }),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::int AS count FROM public.plate_reads WHERE plate_number='DEVICE1'",
      )
    ).rows[0].count,
    1,
    "A changed physical camera never reuses the prior camera's runtime passage",
  );
  for (let number = 1; number <= 5; number++) {
    const firstDevice = `F0000000000${number}`;
    const secondDevice = `F1000000000${number}`;
    const configured = await repository.save({
      camera_name: `Concurrent ${number}`,
      source: "axis",
      device_id: firstDevice,
    });
    const active = await repository.get(configured.input.id);
    const outcomes = await Promise.allSettled([
      repository.receive(
        active,
        body(active, {
          carID: "race",
          plateText: `RACE${number}`,
          capture_timestamp: String(1793291994000 + number),
        }),
        "http",
      ),
      repository.save({ device_id: secondDevice }, active.id),
    ]);
    assert.ok(
      outcomes.some((outcome) => outcome.status === "rejected"),
      "A source identity change cannot strand a concurrently accepted receipt",
    );
    if (outcomes[0].status === "fulfilled")
      assert.equal((await repository.get(active.id)).device_id, firstDevice);
  }
  await pool.query(migrations);
  assert.deepEqual(
    (
      await pool.query("SELECT * FROM public.plate_reads WHERE id=$1", [
        before.id,
      ])
    ).rows[0],
    before,
    "Repeated upgrades preserve existing Blue Iris records",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT direction_label FROM public.current_vehicle_direction_observations WHERE read_id=$1",
        [read.id],
      )
    ).rows[0].direction_label,
    "In",
    "Repeated migrations preserve Axis camera direction",
  );
  const after = await processPlateRead({
    plate_number: "OLD124",
    camera: "Existing BI",
    timestamp: "2026-10-29T15:01:00.000Z",
  });
  assert.equal(after.status, 201);
  console.log(
    "PASS: real PostgreSQL schema/upgrade, existing Blue Iris ingestion, Axis HTTP/MQTT deduplication, corrections, immutable observations, image storage, finalization, carID reuse, manual review preservation, transaction rollback and retry.",
  );
} catch (error) {
  console.error(
    "Axis PostgreSQL validation failed:",
    error.code,
    error.message,
    error.stack,
  );
  try {
    applicationPool ||= await (await import("../lib/db.js")).getPool();
  } catch {}
  throw error;
} finally {
  await applicationPool?.end();
  await pool?.end();
  if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end();
}
