import {
  checkPlateForNotification,
  cleanupOldRecords,
  getPool,
  isPlateIgnored,
} from "@/lib/db";
import { sendPushoverNotification } from "@/lib/notifications";
import { processAcceptedPlateReadEffects } from "@/lib/accepted-plate-read-effects.mjs";
import { createPlateReadEventIdentity } from "@/lib/plate-read-event-identity.mjs";
import { MqttAcceptedReadService } from "@/lib/mqtt/accepted-read-service.mjs";
import { MqttRepository } from "@/lib/mqtt/repository.mjs";
import { getConfig } from "@/lib/settings";
import fileStorage from "@/lib/fileStorage";
import { createIntegrationRouteHandler } from "@/lib/request-auth.mjs";
import { revalidatePath } from "next/cache";

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

async function processPlateRead(data) {
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
        console.error("Invalid Blue Iris plate-read payload");
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
      return Response.json(
        { error: "No valid plates found in request" },
        { status: 400 }
      );
    }

    // Get database connection
    const pool = await getPool();
    dbClient = await pool.connect();
    await dbClient.query("BEGIN");
    transactionOpen = true;
    console.log("Database connection established");

    const mqttRepository = new MqttRepository({
      pool,
      executor: dbClient,
    });
    const mqttService = new MqttAcceptedReadService({
      repository: mqttRepository,
      logger: console,
    });

    const processedPlates = [];
    const duplicatePlates = [];
    const ignoredPlates = [];
    const pendingEffects = [];

    for (const plateData of plates) {
      // Ignored reads must not store images, create database rows, or notify.
      const isIgnored = await isPlateIgnored(plateData.plate_number);
      if (isIgnored) {
        ignoredPlates.push(plateData.plate_number);
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
          console.error("Plate image storage failed");
        }
      }

      // Track files as soon as they are created. Any failure between image
      // storage and COMMIT must remove them along with the rolled-back row.
      if (imagePaths.imagePath || imagePaths.thumbnailPath) {
        transactionImages.push(imagePaths);
      }

      let biPath = null;
      if (data.ALERT_CLIP && data.ALERT_PATH && camera) {
        try {
          const parts = data.ALERT_PATH.split(".");
          const msOffset = parts[2];
          const recId = data.ALERT_CLIP.replace("@", "");
          biPath = `ui3.htm?rec=${recId}-${msOffset}&cam=${camera}`;
        } catch {
          console.error("Blue Iris link construction failed");
        }
      }

      const eventIdentity = createPlateReadEventIdentity({
        plateNumber: plateData.plate_number,
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
            image_data,
            image_path,
            thumbnail_path,
            timestamp,
            camera_name,
            bi_path,
            confidence,
            crop_coordinates,
            ocr_annotation,
            plate_annotation,
            event_identity
          )
          SELECT $1, $2, $3, $4, $5, $6::varchar, $7, $8, $9, $10, $11, $12
          WHERE NOT EXISTS (
            SELECT 1 FROM plate_reads
            WHERE plate_number = $1 AND timestamp = $5
              AND camera_name IS NOT DISTINCT FROM $6::varchar
          )
          ON CONFLICT DO NOTHING
          RETURNING id
        )
        SELECT id FROM new_read`,
        [
          plateData.plate_number,
          null,
          imagePaths.imagePath,
          imagePaths.thumbnailPath,
          timestamp,
          camera,
          biPath,
          plateData.confidence || null,
          plateData.crop_coordinates || null,
          plateData.ocr_annotation || null,
          plateData.plate_annotation || null,
          eventIdentity,
        ]
      );

      if (result.rows.length === 0) {
        duplicatePlates.push(plateData.plate_number);
        await fileStorage
          .deleteImage(imagePaths.imagePath, imagePaths.thumbnailPath)
          .catch(() => console.error("Duplicate plate image cleanup failed"));
        const trackedImageIndex = transactionImages.indexOf(imagePaths);
        if (trackedImageIndex >= 0) {
          transactionImages.splice(trackedImageIndex, 1);
        }
      } else {
        const readId = result.rows[0].id;
        processedPlates.push({
          plate: plateData.plate_number,
          id: readId,
        });

        const acceptedRead = {
          ...plateData,
          id: readId,
          plate_number: plateData.plate_number,
          camera_name: camera,
          timestamp: data.timestamp || null,
          persisted_timestamp: timestamp,
          image_path: imagePaths.imagePath,
          thumbnail_path: imagePaths.thumbnailPath,
          bi_path: biPath,
        };

        const mqttResult = await mqttService.processAcceptedRead(acceptedRead);
        if (mqttResult.status === "error" || mqttResult.status === "partial") {
          throw new Error(
            `MQTT outbox handoff failed for accepted read ${readId}`
          );
        }

        pendingEffects.push({
          read: acceptedRead,
          imageData: data.Image,
          mqttResult,
        });
      }
    }

    await dbClient.query("COMMIT");
    transactionOpen = false;

    // The durable MQTT handoff committed with each read. Remote Pushover
    // delivery remains best-effort and runs only after the transaction commits.
    for (const effect of pendingEffects) {
      try {
        await processAcceptedPlateReadEffects({
          read: effect.read,
          imageData: effect.imageData,
          shouldSendPushover: checkPlateForNotification,
          sendPushover: sendPushoverNotification,
          processMqtt: async () => effect.mqttResult,
          logger: console,
        });
      } catch {
        console.error("Accepted plate notification processing failed");
      }
    }

    const config = await getConfig();
    cleanupOldRecords(config.general.maxRecords).catch(() =>
      console.error("Database pruning failed")
    );

    fileStorage.cleanupOldFiles(config.general.retention).catch(() => {
      console.error("JPEG pruning failed");
    });

    // if (processedPlates.length > 0) {
    //   console.log("New plate(s) processed, notifying clients");

    //   // Add revalidation here as well for good measure
    //   await revalidatePlatesPage();
    // }
    if (processedPlates.length > 0) {
      try {
        console.log("⭐ Plate Received");
        revalidatePath("/live_feed");
        // Ensure revalidation completes
        await new Promise((resolve) => setTimeout(resolve, 100));
        // console.log("⭐ Revalidation completed");
      } catch {
        console.error("Plate page revalidation failed");
      }
    }

    return Response.json(
      {
        processed: processedPlates,
        duplicates: duplicatePlates,
        ignored: ignoredPlates,
        message: `Processed ${processedPlates.length} plates, ${duplicatePlates.length} duplicates, ${ignoredPlates.length} ignored`,
      },
      { status: processedPlates.length > 0 ? 201 : 409 }
    );
  } catch (error) {
    const shouldDeleteTransactionImages = transactionOpen;

    if (dbClient && transactionOpen) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        console.error("Plate-read transaction rollback failed");
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

export const POST = createIntegrationRouteHandler(processPlateRead);
