import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import crypto from "crypto";
import {
  isPathInside,
  resolveStoragePath,
  sanitizeStorageComponent,
} from "./storage-path.mjs";

export class FileStorage {
  constructor(options = {}) {
    this.baseDir =
      options.baseDir ||
      process.env.STORAGE_PATH ||
      path.join(process.cwd(), "storage");

    // Keep root directories for backwards compatibility
    this.imagesDir = path.join(this.baseDir, "images");
    this.thumbnailsDir = path.join(this.baseDir, "thumbnails");
    this.derivedDir = path.join(this.baseDir, "derived");
  }

  async initialize() {
    try {
      // Create root directories
      await fs.mkdir(this.baseDir, { recursive: true });
      await fs.mkdir(this.imagesDir, { recursive: true });
      await fs.mkdir(this.thumbnailsDir, { recursive: true });
      await fs.mkdir(this.derivedDir, { recursive: true });

      // Verify access
      await fs.access(this.baseDir);
      await fs.access(this.imagesDir);
      await fs.access(this.thumbnailsDir);
      await fs.access(this.derivedDir);
    } catch (error) {
      console.error("File storage initialization failed");
      throw error;
    }
  }

  async resolveExistingImagePath(imagePath) {
    const candidatePath = resolveStoragePath(this.baseDir, imagePath);
    const [realCandidatePath, realImagesDir, realThumbnailsDir, realDerivedDir] =
      await Promise.all([
        fs.realpath(candidatePath),
        fs.realpath(this.imagesDir),
        fs.realpath(this.thumbnailsDir),
        fs.realpath(this.derivedDir),
      ]);

    if (
      !isPathInside(realImagesDir, realCandidatePath) &&
      !isPathInside(realThumbnailsDir, realCandidatePath) &&
      !isPathInside(realDerivedDir, realCandidatePath)
    ) {
      throw new Error("Invalid storage path");
    }

    return realCandidatePath;
  }

  async saveDerivedImage(relativePath, imageData) {
    const fullPath = resolveStoragePath(this.baseDir, relativePath, ["derived"]);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, imageData);
    return relativePath;
  }

  generateStoragePath(plateNumber, backdate = null) {
    const timestamp = backdate ? new Date(backdate).getTime() : Date.now();
    const random = crypto.randomBytes(4).toString("hex");
    const safePlateNumber = sanitizeStorageComponent(plateNumber);
    const filename = `${safePlateNumber}_${timestamp}_${random}`;

    // Create date-based directory structure
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const datePath = path.join(String(year), month, day);

    // Create both paths
    const imagePath = path.join("images", datePath, `${filename}.jpg`);
    const thumbnailPath = path.join(
      "thumbnails",
      datePath,
      `${filename}_thumb.jpg`
    );

    // Full paths for file operations
    const fullImagePath = path.join(this.baseDir, imagePath);
    const fullThumbnailPath = path.join(this.baseDir, thumbnailPath);

    // Directory paths for creation
    const imageDir = path.dirname(fullImagePath);
    const thumbnailDir = path.dirname(fullThumbnailPath);

    return {
      imagePath,
      thumbnailPath,
      fullImagePath,
      fullThumbnailPath,
      imageDir,
      thumbnailDir,
      timestamp,
    };
  }

  async saveImage(base64Data, plateNumber) {
    if (!base64Data) {
      console.log("[FileStorage] No image data provided");
      return { imagePath: null, thumbnailPath: null };
    }

    try {
      // Generate paths
      const paths = this.generateStoragePath(plateNumber);

      // Create date-based directories
      await fs.mkdir(paths.imageDir, { recursive: true });
      await fs.mkdir(paths.thumbnailDir, { recursive: true });

      // Process image data
      const imageData = base64Data.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(imageData, "base64");

      // Save original
      await sharp(buffer).jpeg({ quality: 85 }).toFile(paths.fullImagePath);

      // Save thumbnail
      await sharp(buffer)
        .resize(200, 150, { fit: "inside" })
        .jpeg({ quality: 70 })
        .toFile(paths.fullThumbnailPath);

      console.log("[FileStorage] Successfully saved image");

      // Return relative paths for database storage
      return {
        imagePath: paths.imagePath,
        thumbnailPath: paths.thumbnailPath,
      };
    } catch (error) {
      console.error("File storage image save failed");
      throw error;
    }
  }

  async getImage(imagePath) {
    try {
      const fullPath = await this.resolveExistingImagePath(imagePath);
      const data = await fs.readFile(fullPath);
      return data;
    } catch {
      console.error("File storage image access failed");
      return null;
    }
  }

  async deleteImage(imagePath, thumbnailPath) {
    try {
      const operations = [];

      if (imagePath) {
        operations.push(
          this.resolveExistingImagePath(imagePath).then((fullPath) =>
            fs.unlink(fullPath)
          )
        );
      }
      if (thumbnailPath) {
        operations.push(
          this.resolveExistingImagePath(thumbnailPath).then((fullPath) =>
            fs.unlink(fullPath)
          )
        );
      }

      await Promise.all(operations);
      console.log("[FileStorage] Successfully deleted images");
    } catch {
      console.error("File storage image deletion failed");
    }
  }

  async migrateBase64ToFile(base64Data, plateNumber, timestamp) {
    if (!base64Data) return { imagePath: null, thumbnailPath: null };

    try {
      const imageData = base64Data.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(imageData, "base64");

      const paths = this.generateStoragePath(plateNumber, timestamp);

      // Ensure directories exist
      await fs.mkdir(paths.imageDir, { recursive: true });
      await fs.mkdir(paths.thumbnailDir, { recursive: true });

      // Save files
      await sharp(buffer).jpeg({ quality: 85 }).toFile(paths.fullImagePath);

      await sharp(buffer)
        .resize(200, 150, { fit: "inside" })
        .jpeg({ quality: 70 })
        .toFile(paths.fullThumbnailPath);

      return {
        imagePath: paths.imagePath,
        thumbnailPath: paths.thumbnailPath,
      };
    } catch (error) {
      console.error("File storage image migration failed");
      throw error;
    }
  }

  async cleanupOldFiles(retentionMonths) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - retentionMonths);

      const directories = ["images", "thumbnails", "derived"];

      for (const dir of directories) {
        const baseDir = path.join(this.baseDir, dir);
        const years = await fs.readdir(baseDir);

        for (const year of years) {
          const yearPath = path.join(baseDir, year);
          const months = await fs.readdir(yearPath);

          for (const month of months) {
            const monthPath = path.join(yearPath, month);
            const days = await fs.readdir(monthPath);

            const pathDate = new Date(parseInt(year), parseInt(month) - 1, 1);

            if (pathDate < cutoffDate) {
              await fs.rm(monthPath, { recursive: true, force: true });
              console.log("File storage removed an expired image directory");
              continue;
            }

            // If month is current, check individual days
            for (const day of days) {
              const dayPath = path.join(monthPath, day);
              const fullDate = new Date(
                parseInt(year),
                parseInt(month) - 1,
                parseInt(day)
              );

              if (fullDate < cutoffDate) {
                await fs.rm(dayPath, { recursive: true, force: true });
                console.log("File storage removed an expired image directory");
              }
            }
          }

          // Cleanup empty month directories
          try {
            const remainingMonths = await fs.readdir(yearPath);
            if (remainingMonths.length === 0) {
              await fs.rmdir(yearPath);
              console.log("File storage removed an empty image directory");
            }
          } catch {
            console.error("File storage directory cleanup failed");
          }
        }
      }

      console.log("[FileStorage] JPEG Prune Successful");
    } catch {
      console.error("File storage cleanup failed");
    }
  }
}

const fileStorage = new FileStorage();
await fileStorage.initialize();

export default fileStorage;
