import {
  checkPlateForNotification,
  getPool,
  isPlateIgnored,
} from "@/lib/db";
import { sendPushoverNotification } from "@/lib/notifications";
import {
  processAcceptedPlateReadEffects,
} from "@/lib/accepted-plate-read-effects.mjs";
import { NotificationAcceptedReadService } from "@/lib/notification-accepted-read-service.mjs";
import { NotificationRuntimeRepository } from "@/lib/notification-runtime-repository.mjs";
import { createPlateReadEventIdentity } from "@/lib/plate-read-event-identity.mjs";
import { parseBlueIrisAlertPointer } from "@/lib/blue-iris-alert-pointer.mjs";
import {
  applyBlueIrisDirectionEligibility,
  blueIrisTriggerDirectionColumns,
  persistBlueIrisPrimaryDirectionForRead,
  resolveBlueIrisTriggerDirectionForRead,
} from "@/lib/blue-iris-trigger-direction.mjs";
import { assessDirectionImageEligibility } from "@/lib/direction-image-eligibility.mjs";
import { wakeBlueIrisVehicleFrameWorker } from "@/lib/blue-iris-vehicle-frame-runtime.mjs";
import {
  recordAliasApplicationWithClient,
  resolvePlateAliasWithClient,
} from "@/lib/plate-review-repository.mjs";
import { MqttAcceptedReadService } from "@/lib/mqtt/accepted-read-service.mjs";
import { MqttRepository } from "@/lib/mqtt/repository.mjs";
import { getConfig } from "@/lib/settings";
import fileStorage from "@/lib/fileStorage";
import { createIntegrationIngressRecorder } from "@/lib/integration-ingress.mjs";
import { createIntegrationRouteHandler } from "@/lib/request-auth.mjs";
import { overviewReadQueueState } from "@/lib/vehicle-overview-association.mjs";
import { createComponentLogger } from "@/logging/logger";
import { revalidatePath } from "next/cache";

const plateIngressLogger = createComponentLogger("plate-read-ingress");
const plateIngressRecorder = createIntegrationIngressRecorder({
  query: async (text, values) => {
    const pool = await getPool();
    return pool.query(text, values);
  },
  logger: plateIngressLogger,
});

// Revised to use a blacklist of all other possible AI labels if using the memo
const EXCLUDED_LABELS = [
  "person",
  "bicycle",
  "car",
  "motorcycle",
  "bus",
  "truck",
  "bird",
  "cat",
  "dog",
  "horse",
  "sheep",
  "cow",
  "bear",
  "deer",
  "rabbit",
  "raccoon",
  "fox",
  "skunk",
  "squirrel",
  "pig",
  "vehicle",
  "boat",
  "bottle",
  "chair",
  "cup",
  "table",
  "airplane",
  "train",
  "traffic light",
  "fire hydrant",
  "stop sign",
  "parking meter",
  "bench",
  "elephant",
  "zebra",
  "giraffe",
  "backpack",
  "umbrella",
  "handbag",
  "tie",
  "suitcase",
  "frisbee",
  "skis",
  "snowboard",
  "sports ball",
  "kite",
  "baseball bat",
  "baseball glove",
  "skateboard",
  "surfboard",
  "tennis racket",
  "wine glass",
  "fork",
  "knife",
  "spoon",
  "bowl",
  "banana",
  "apple",
  "sandwich",
  "orange",
  "broccoli",
  "carrot",
  "hot dog",
  "pizza",
  "donut",
  "cake",
  "couch",
  "potted plant",
  "bed",
  "dining table",
  "toilet",
  "tv",
  "laptop",
  "mouse",
  "remote",
  "keyboard",
  "cell phone",
  "microwave",
  "oven",
  "toaster",
  "sink",
  "refrigerator",
  "book",
  "clock",
  "vase",
  "scissors",
  "teddy bear",
  "hair drier",
  "toothbrush",
  "plate",
  "dayplate",
  "nightplate",
  "people",
  "motorbike",
].map((label) => label.toLowerCase());

function extractPlatesFromMemo(memo) {
  if (!memo) {
    return [];
  }

  // Split up all the detected objects/plates in memo
  const detections = memo.split(",").map((d) => d.trim());

  // Process each item in the memo
  const plates = detections
    .map((detection) => {
      // Split by colon to separate label from confidence
      const [label] = detection.split(":");

      if (!label) {
        return null;
      }

      // Convert to lowercase for comparison
      const normalizedLabel = label.trim().toLowerCase();

      // ignore other AI objects and only return plates
      if (EXCLUDED_LABELS.includes(normalizedLabel)) {
        return null;
      }

      // The older dayplate and nightplate models return the plate in brackets
      let plateNumber = label.trim();
      if (plateNumber.includes("[") && plateNumber.includes("]")) {
        plateNumber = plateNumber.replace(/\[|\]/g, "");
      }

      // Return cleaned plate number in uppercase
      return plateNumber.toUpperCase();
    })
    .filter((plate) => plate !== null);

  return [...new Set(plates)]; // Remove duplicates
}

async function processPlateRead(data, _request, context = {}) {
  let dbClient = null;
  let transactionOpen = false;
  const transactionImages = [];

  try {
    // Preserve whether Blue Iris supplied a timestamp. The database still gets
    // a valid server timestamp when it is missing, while the MQTT payload can
    // label that case as a server-receipt fallback.
    const timestamp = data.timestamp || new Date().toISOString();
    const camera = data.camera || null;
    let plates = [];

    // Handle AI dump format if present
    if (data.ai_dump) {
      try {
        const aiDumpArray = Array.isArray(data.ai_dump)
          ? data.ai_dump
          : [data.ai_dump];

        // Find the ALPR response in the ai_dump array
        const aiData = aiDumpArray.find((item) => item?.api === "alpr");

        if (aiData?.found?.predictions) {
          // Get all plate annotations for this batch
          const allPlateAnnotations = aiData.found.predictions
            .filter((pred) => pred.valid_ocr_annotation)
            .map((pred) => pred.plate_annotation)
            .filter(Boolean)
            .join("&");

          // Process each prediction
          plates = aiData.found.predictions.map((prediction) => ({
            plate_number: prediction.plate?.toUpperCase(),
            confidence: prediction.confidence.toFixed(2),
            crop_coordinates: [
              prediction.x_min,
              prediction.y_min,
              prediction.x_max,
              prediction.y_max,
            ],
            ...(prediction.valid_ocr_annotation && {
              ocr_annotation: {
                ocr_annotation: prediction.ocr_annotation,
              },
              plate_annotation: allPlateAnnotations,
            }),
          }));
        }
      } catch {
        context.setOutcome?.({
          outcome: "invalid_plate_payload",
          errorCode: "INVALID_PLATE_PAYLOAD",
        });
        plateIngressLogger.warn("plate_read_payload_invalid", {
          requestId: context.requestId,
          cameraName: camera,
          errorCode: "INVALID_PLATE_PAYLOAD",
        });
        return Response.json(
          { error: "Invalid plate-read payload" },
          { status: 400 }
        );
      }
    }
    // Backwards compatibility for older formats
    else if (data.memo) {
      //extract plates from memo
      plates = extractPlatesFromMemo(data.memo).map((plate) => ({
        plate_number: plate,
      }));
    } else if (data.plate_number) {
      plates = [
        {
          plate_number: data.plate_number.toUpperCase(),
        },
      ];
    }

    if (plates.length === 0) {
      context.setOutcome?.({
        outcome: "no_valid_plates",
        errorCode: "NO_VALID_PLATES",
      });
      return Response.json(
        { error: "No valid plates found in request" },
        { status: 400 }
      );
    }

    let directionImageEligibility;
    try {
      directionImageEligibility = await assessDirectionImageEligibility(data.Image);
    } catch {
      directionImageEligibility = {
        eligible: false,
        evaluated: false,
        monochrome: false,
        monochromeRatio: null,
        reason: "direction_image_assessment_failed",
      };
      plateIngressLogger.warn("direction_image_assessment_failed", {
        requestId: context.requestId,
        cameraName: camera,
        errorCode: "DIRECTION_IMAGE_ASSESSMENT_FAILED",
      });
    }

    // Get database connection
    const pool = await getPool();
    dbClient = await pool.connect();
    await dbClient.query("BEGIN");
    transactionOpen = true;

    const config = await getConfig();
    const mqttRepository = new MqttRepository({
      pool,
      executor: dbClient,
    });
    const mqttService = new MqttAcceptedReadService({
      repository: mqttRepository,
      logger: plateIngressLogger,
      matchingSettings: config.plateMatching,
    });
    const notificationService = new NotificationAcceptedReadService({
      repository: new NotificationRuntimeRepository({ executor: dbClient }),
      mqttRepository,
      logger: plateIngressLogger,
      matchingSettings: config.plateMatching,
    });
    const resolvedBlueIrisTriggerDirection = await resolveBlueIrisTriggerDirectionForRead({
      query: (text, values) => dbClient.query(text, values),
      camera,
      value: data.trigger_type ?? data.triggerType ?? data.TYPE,
    });
    const blueIrisTriggerDirection = applyBlueIrisDirectionEligibility(
      resolvedBlueIrisTriggerDirection,
      directionImageEligibility
    );
    const blueIrisTriggerColumns = blueIrisTriggerDirectionColumns(blueIrisTriggerDirection);
    const overviewVehicleView = overviewReadQueueState({
      eligibility: directionImageEligibility,
      directionStatus: blueIrisTriggerColumns.bi_trigger_direction_status,
      directionLabel: blueIrisTriggerColumns.bi_trigger_direction_label,
    });

    const processedPlates = [];
    const duplicatePlates = [];
    const ignoredPlates = [];
    const pendingEffects = [];
    let overviewWorkQueued = false;
    const blueIrisAlert = parseBlueIrisAlertPointer({
      clip: data.ALERT_CLIP,
      path: data.ALERT_PATH,
      camera,
    });

    for (const plateData of plates) {
      const observedPlate = plateData.plate_number;
      const alias = await resolvePlateAliasWithClient(dbClient, {
        observedPlate,
        cameraName: camera,
      });
      const effectivePlate = alias?.target_plate || observedPlate;
      const effectivePlateData = {
        ...plateData,
        observed_plate: observedPlate,
        plate_number: effectivePlate,
      };

      // Ignore decisions use the effective identity so a reviewed alias inherits
      // the known plate's behavior without altering the immutable observation.
      const isIgnored = await isPlateIgnored(effectivePlate);
      if (isIgnored) {
        ignoredPlates.push(observedPlate);
        continue;
      }

      let imagePaths = { imagePath: null, thumbnailPath: null };
      if (data.Image) {
        try {
          imagePaths = await fileStorage.saveImage(
            data.Image,
            plateData.plate_number
          );
        } catch {
          plateIngressLogger.error("plate_image_storage_failed", {
            requestId: context.requestId,
            cameraName: camera,
            errorCode: "PLATE_IMAGE_STORAGE_FAILED",
          });
        }
      }

      // Track files as soon as they are created. Any failure between image
      // storage and COMMIT must remove them along with the rolled-back row.
      if (imagePaths.imagePath || imagePaths.thumbnailPath) {
        transactionImages.push(imagePaths);
      }

      const biPath = blueIrisAlert.playbackPath;

      const eventIdentity = createPlateReadEventIdentity({
        plateNumber: observedPlate,
        timestamp,
        cameraName: camera,
      });

      const result = await dbClient.query(
        `WITH new_plate AS (
          INSERT INTO plates (plate_number)
          VALUES ($1)
          ON CONFLICT (plate_number) DO NOTHING
        ),
        new_read AS (
          INSERT INTO plate_reads (
            plate_number,
            observed_plate,
            applied_alias_id,
            review_status,
            review_revision,
            validated,
            image_data,
            image_path,
            thumbnail_path,
            timestamp,
            camera_name,
            bi_path,
            bi_alert_clip,
            bi_alert_path,
            bi_alert_offset_ms,
            bi_trigger_type,
            bi_trigger_direction_status,
            bi_trigger_direction_label,
            bi_trigger_direction_profile_version,
            bi_trigger_direction_algorithm,
            bi_trigger_direction_error_code,
            confidence,
            crop_coordinates,
            ocr_annotation,
            plate_annotation,
            event_identity,
            vehicle_image_status,
            vehicle_image_queue_kind,
            vehicle_image_attempt_count,
            vehicle_image_retryable,
            vehicle_image_error_code,
            vehicle_image_updated_at
          )
          SELECT $1, $2::varchar, $3,
                 CASE WHEN $3::bigint IS NULL THEN 'unreviewed' ELSE 'alias_resolved' END,
                 CASE WHEN $3::bigint IS NULL THEN 0 ELSE 1 END,
                 ($3::bigint IS NOT NULL),
                 $4, $5, $6, $7, $8::varchar, $9, $10, $11, $12,
                 $18, $19, $20, $21, $22, $23,
                 $13, $14, $15, $16, $17,
                 $24, $25, 0, $26, $27, CURRENT_TIMESTAMP
          WHERE NOT EXISTS (
            SELECT 1 FROM plate_reads
            WHERE observed_plate = $2::varchar AND timestamp = $7
              AND camera_name IS NOT DISTINCT FROM $8::varchar
          )
          ON CONFLICT DO NOTHING
          RETURNING id
        )
        SELECT id FROM new_read`,
        [
          effectivePlate,
          observedPlate,
          alias?.id || null,
          null,
          imagePaths.imagePath,
          imagePaths.thumbnailPath,
          timestamp,
          camera,
          biPath,
          blueIrisAlert.alertClip,
          blueIrisAlert.alertPath,
          blueIrisAlert.offsetMs,
          effectivePlateData.confidence || null,
          effectivePlateData.crop_coordinates || null,
          effectivePlateData.ocr_annotation || null,
          effectivePlateData.plate_annotation || null,
          eventIdentity,
          blueIrisTriggerColumns.bi_trigger_type,
          blueIrisTriggerColumns.bi_trigger_direction_status,
          blueIrisTriggerColumns.bi_trigger_direction_label,
          blueIrisTriggerColumns.bi_trigger_direction_profile_version,
          blueIrisTriggerColumns.bi_trigger_direction_algorithm,
          blueIrisTriggerColumns.bi_trigger_direction_error_code,
          overviewVehicleView.status,
          overviewVehicleView.queueKind,
          overviewVehicleView.retryable,
          overviewVehicleView.errorCode,
        ]
      );

      if (result.rows.length === 0) {
        duplicatePlates.push(observedPlate);
        await fileStorage
          .deleteImage(imagePaths.imagePath, imagePaths.thumbnailPath)
          .catch(() => plateIngressLogger.warn("duplicate_plate_image_cleanup_failed", {
            requestId: context.requestId,
            cameraName: camera,
            errorCode: "DUPLICATE_IMAGE_CLEANUP_FAILED",
          }));
        const trackedImageIndex = transactionImages.indexOf(imagePaths);
        if (trackedImageIndex >= 0) {
          transactionImages.splice(trackedImageIndex, 1);
        }
      } else {
        const readId = result.rows[0].id;
        const primaryDirection = await persistBlueIrisPrimaryDirectionForRead({
          query: (text, values) => dbClient.query(text, values),
          readId,
          camera,
          evidence: blueIrisTriggerDirection,
        });
        await recordAliasApplicationWithClient(dbClient, {
          readId,
          eventIdentity,
          alias,
          observedPlate,
        });
        processedPlates.push({
          plate: effectivePlate,
          observedPlate,
          id: readId,
          aliasApplied: Boolean(alias),
        });
        if (overviewVehicleView.queueKind === "overview") overviewWorkQueued = true;

        const acceptedRead = {
          ...effectivePlateData,
          id: readId,
          plate_number: effectivePlate,
          camera_name: camera,
          timestamp: data.timestamp || null,
          persisted_timestamp: timestamp,
          image_path: imagePaths.imagePath,
          thumbnail_path: imagePaths.thumbnailPath,
          bi_path: biPath,
          bi_alert_clip: blueIrisAlert.alertClip,
          bi_alert_path: blueIrisAlert.alertPath,
          bi_alert_offset_ms: blueIrisAlert.offsetMs,
          ...blueIrisTriggerColumns,
        };

        const mqttResult = await mqttService.processAcceptedRead(acceptedRead);
        if (mqttResult.status === "error" || mqttResult.status === "partial") {
          throw new Error(
            `MQTT outbox handoff failed for accepted read ${readId}`
          );
        }
        const unifiedResult = await notificationService.processAcceptedRead(acceptedRead);
        if (unifiedResult.status === "error" || unifiedResult.status === "partial") {
          throw new Error(
            `Unified notification outbox handoff failed for accepted read ${readId}`
          );
        }
        if (primaryDirection) {
          const directionResult = await notificationService.processVehicleDirection(
            acceptedRead,
            primaryDirection
          );
          if (directionResult.status === "error" || directionResult.status === "partial") {
            throw new Error(
              `Blue Iris direction notification outbox handoff failed for accepted read ${readId}`
            );
          }
        }

        pendingEffects.push({
          read: acceptedRead,
          imageData: data.Image,
          mqttResult,
          unifiedResult,
        });
      }
    }

    await dbClient.query("COMMIT");
    transactionOpen = false;
    if (overviewWorkQueued) wakeBlueIrisVehicleFrameWorker();

    // Unified MQTT and Pushover handoffs committed with each read. The legacy
    // Pushover path remains post-commit until every migrated rule is cut over.
    for (const effect of pendingEffects) {
      try {
        await processAcceptedPlateReadEffects({
          read: effect.read,
          imageData: effect.imageData,
          shouldSendPushover: checkPlateForNotification,
          sendPushover: sendPushoverNotification,
          processMqtt: async () => effect.mqttResult,
          logger: plateIngressLogger,
        });
      } catch {
        plateIngressLogger.error("accepted_plate_notification_processing_failed", {
          requestId: context.requestId,
          processedCount: processedPlates.length,
          errorCode: "ACCEPTED_READ_EFFECT_FAILED",
        });
      }
    }

    // if (processedPlates.length > 0) {
    //   console.log("New plate(s) processed, notifying clients");

    //   // Add revalidation here as well for good measure
    //   await revalidatePlatesPage();
    // }
    if (processedPlates.length > 0) {
      try {
        revalidatePath("/live_feed");
        // Ensure revalidation completes
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        plateIngressLogger.warn("plate_feed_revalidation_failed", {
          requestId: context.requestId,
          processedCount: processedPlates.length,
          errorCode: "PLATE_FEED_REVALIDATION_FAILED",
        });
      }
    }

    const responseStatus = processedPlates.length > 0 ? 201 : 409;
    const outcome = processedPlates.length > 0
      ? "accepted"
      : duplicatePlates.length > 0
        ? "duplicate"
        : ignoredPlates.length > 0
          ? "ignored"
          : "no_changes";
    const outcomeDetails = {
      outcome,
      processedReadIds: processedPlates.map(({ id }) => id),
      processedCount: processedPlates.length,
      duplicateCount: duplicatePlates.length,
      ignoredCount: ignoredPlates.length,
      overviewWorkQueued,
    };
    context.setOutcome?.(outcomeDetails);
    plateIngressLogger.info("plate_read_ingress_completed", {
      requestId: context.requestId,
      cameraName: camera,
      httpStatus: responseStatus,
      ...outcomeDetails,
    });

    return Response.json(
      {
        processed: processedPlates,
        duplicates: duplicatePlates,
        ignored: ignoredPlates,
        message: `Processed ${processedPlates.length} plates, ${duplicatePlates.length} duplicates, ${ignoredPlates.length} ignored`,
      },
      { status: responseStatus }
    );
  } catch (error) {
    const shouldDeleteTransactionImages = transactionOpen;

    if (dbClient && transactionOpen) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        plateIngressLogger.error("plate_read_transaction_rollback_failed", {
          requestId: context.requestId,
          errorCode: "PLATE_READ_ROLLBACK_FAILED",
        });
      }
    }

    if (shouldDeleteTransactionImages) {
      await Promise.allSettled(
        transactionImages.map(({ imagePath, thumbnailPath }) =>
          fileStorage.deleteImage(imagePath, thumbnailPath)
        )
      );
    }

    throw error;
  } finally {
    if (dbClient) {
      dbClient.release();
    }
  }
}

export const POST = createIntegrationRouteHandler(processPlateRead, {
  integration: "blue_iris",
  routeName: "/api/plate-reads",
  logger: plateIngressLogger,
  recorder: plateIngressRecorder,
});
