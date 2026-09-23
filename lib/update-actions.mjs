export function createUpdateActions({
  authenticate,
  backfillOccurrenceCounts,
  getTotalRecordsToMigrate,
  getRecordsToMigrate,
  migrateBase64ToFile,
  updateImagePathsBatch,
  clearImageDataBatch,
  markUpdateComplete,
  verifyImageMigration,
  logger = console,
}) {
  async function runAuthenticated(operation) {
    await authenticate();
    return await operation();
  }

  async function completeUpdateOperation() {
    try {
      await markUpdateComplete();
      return { success: true };
    } catch (error) {
      logger.error("Error marking update complete:", error);
      return { success: false, error: error.message };
    }
  }

  return {
    async dbBackfill() {
      return await runAuthenticated(async () => {
        logger.warn("Backfilling occurrence counts...");
        return await backfillOccurrenceCounts();
      });
    },

    async migrateImageDataToFiles() {
      return await runAuthenticated(async () => {
        logger.log("Starting image data migration...");

        try {
          const totalRecords = await getTotalRecordsToMigrate();
          logger.log(`Total records to migrate: ${totalRecords}`);

          let processed = 0;
          let errors = 0;
          let lastId = 0;
          const BATCH_SIZE = 100;

          while (true) {
            const records = await getRecordsToMigrate(BATCH_SIZE, lastId);
            if (records.length === 0) break;

            const updates = [];

            for (const record of records) {
              try {
                const { imagePath, thumbnailPath } =
                  await migrateBase64ToFile(
                    record.image_data,
                    record.plate_number,
                    record.timestamp
                  );

                updates.push({ id: record.id, imagePath, thumbnailPath });
                processed++;
              } catch (error) {
                logger.error(`Error processing record ${record.id}:`, error);
                errors++;
              }

              lastId = record.id;
            }

            if (updates.length > 0) {
              try {
                await updateImagePathsBatch(updates);
              } catch (error) {
                logger.error("Error updating batch:", error);
                errors += updates.length;
                processed -= updates.length;
              }
            }

            logger.log(
              `Processed ${processed}/${totalRecords} records (${errors} errors)`
            );
          }

          return {
            success: true,
            processed,
            errors,
            totalRecords,
          };
        } catch (error) {
          logger.error("Migration failed:", error);
          return {
            success: false,
            error: error.message,
          };
        }
      });
    },

    async clearImageData() {
      return await runAuthenticated(async () => {
        logger.log("Starting image data cleanup...");

        try {
          let totalCleared = 0;
          let batchCount;

          do {
            batchCount = await clearImageDataBatch(1000);
            totalCleared += batchCount;
            logger.log(`Cleared ${totalCleared} records...`);
          } while (batchCount > 0);

          return {
            success: true,
            clearedCount: totalCleared,
          };
        } catch (error) {
          logger.error("Cleanup failed:", error);
          return {
            success: false,
            error: error.message,
          };
        }
      });
    },

    async completeUpdate() {
      return await runAuthenticated(completeUpdateOperation);
    },

    async skipImageMigration() {
      return await runAuthenticated(async () => {
        try {
          const verificationResult = await verifyImageMigration();

          if (!verificationResult.success) {
            return {
              success: false,
              error: "Could not verify migration status",
            };
          }

          if (!verificationResult.isComplete) {
            return {
              success: false,
              error: `Cannot skip migration: ${verificationResult.incompleteCount} records still need migration`,
            };
          }

          await completeUpdateOperation();
          return { success: true };
        } catch (error) {
          logger.error("Error in skipImageMigration:", error);
          return { success: false, error: error.message };
        }
      });
    },
  };
}
