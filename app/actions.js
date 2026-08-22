"use server";

//This is extremely sloppy. Should really clean up the actions.

import {
  getAvailableTags,
  createTag,
  updateTagColor,
  deleteTag,
  updateKnownPlate,
  removeKnownPlate,
  addTagToPlate,
  removeTagFromPlate,
  getPlateHistory,
  getPlateReads,
  getAllPlates,
  getPlateInsights,
  getKnownPlates,
  togglePlateFlag,
  getMetrics,
  getFlaggedPlates,
  removePlate,
  removePlateRead,
  getPool,
  resetPool,
  getTagsForPlate,
  correctAllPlateReads,
  getDistinctCameraNames,
  getDistinctDirectionLabels,
  togglePlateIgnore,
  getPlateImagePreviews,
  backfillOccurrenceCounts,
  clearImageDataWithPathVerification,
  updateImagePaths,
  getRecordsToMigrate,
  clearImageDataBatch,
  updateImagePathsBatch,
  getTotalRecordsToMigrate,
  verifyImageMigration,
  checkUpdateStatus,
  markUpdateComplete,
  updateTagName,
  addUnseenPlate,
} from "@/lib/db";
import { normalizePlateMatchingSettings } from "@/lib/plate-matching.mjs";
import { getPlateReviewRepository } from "@/lib/plate-review-runtime.mjs";
import {
  applyDisabledNotificationMigration,
  getNotificationMigrationPreview as loadNotificationMigrationPreview,
} from "@/lib/notification-migration-runtime.mjs";
import {
  approveNotificationShadowReview as recordNotificationShadowReviewApproval,
  getNotificationShadowReview as loadNotificationShadowReview,
} from "@/lib/notification-shadow-review-runtime.mjs";
import {
  cutoverNotificationRule,
  getNotificationCutoverPreview as loadNotificationCutoverPreview,
  retireOrphanedNotificationRule,
  rollbackNotificationRule,
} from "@/lib/notification-cutover-runtime.mjs";
import {
  finalizeNotificationLegacyMigration,
  getNotificationLegacyFinalizationPreview as loadNotificationLegacyFinalizationPreview,
} from "@/lib/notification-mqtt-finalization-runtime.mjs";
import {
  simulateNotificationRuleDraft,
  updateNotificationRuleDraft,
} from "@/lib/notification-rule-draft-runtime.mjs";
import {
  createNotificationRuleDraft,
  deleteNotificationRuleBuilderRule,
  getNotificationRuleBuilderOverview as loadNotificationRuleBuilderOverview,
  getNotificationOperationsOverview as loadNotificationOperationsOverview,
  previewNotificationRuleBuilder,
  setNotificationRuleBuilderEnabled,
  updateNotificationRuleBuilderDraft,
} from "@/lib/notification-rule-builder-runtime.mjs";
import { parseNotificationRuleDraft } from "@/lib/notification-rule-builder-shape.mjs";
import { getCaptureAssetService } from "@/lib/capture-asset-runtime.mjs";
import {
  getVisualIndexRuntimeStatus,
  wakeVisualIndexWorker,
} from "@/lib/visual-index-runtime.mjs";
import {
  getVehicleImageAssetCatalogRuntime,
  getVehicleImageAssetCatalogWorkerStatus,
  wakeVehicleImageAssetCatalogWorker,
} from "@/lib/vehicle-image-asset-catalog-runtime.mjs";
import {
  getVehicleEventShadowRuntime,
  getVehicleEventShadowWorkerStatus,
  wakeVehicleEventShadowWorker,
} from "@/lib/vehicle-event-shadow-runtime.mjs";
import {
  getVehicleImageCropRuntime,
  getVehicleImageCropWorkerStatus,
  wakeVehicleImageCropWorker,
} from "@/lib/vehicle-image-crop-runtime.mjs";
import {
  getVehicleAssetEmbeddingRuntime,
  getVehicleAssetEmbeddingWorkerStatus,
  wakeVehicleAssetEmbeddingWorker,
} from "@/lib/vehicle-asset-embedding-runtime.mjs";
import {
  getVehicleAssetAttributeRuntime,
  getVehicleAssetAttributeWorkerStatus,
  wakeVehicleAssetAttributeWorker,
} from "@/lib/vehicle-asset-attribute-runtime.mjs";
import { getVehicleReidV2ShadowService } from "@/lib/vehicle-reid-v2-shadow-runtime.mjs";
import { getVehicleReidV2ConversionService } from "@/lib/vehicle-reid-v2-conversion-runtime.mjs";
import { getVehicleReidV2AuthorityService } from "@/lib/vehicle-reid-v2-authority-runtime.mjs";
import {
  getVehicleReidV2LiveRuntime,
  getVehicleReidV2LiveWorkerStatus,
  wakeVehicleReidV2LiveWorker,
} from "@/lib/vehicle-reid-v2-live-runtime.mjs";
import {
  applyVisualIndexPace,
  normalizeVisualIndexSettings,
  visualIndexPace,
} from "@/lib/visual-index-settings.mjs";
import { revalidatePath, revalidateTag, unstable_noStore } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import crypto from "crypto";
import { getConfig, saveConfig } from "@/lib/settings";
import {
  resolveStoredSecretUpdate,
  sanitizeSettingsForClient,
} from "@/lib/settings-client.mjs";
import {
  createSession,
  invalidateSession,
  verifyPassword, // The function that handles both old/new hashes
  hashPasswordBcrypt, // New export to create a bcrypt hash
  getSessionPrincipal,
  getAuthConfig, // Need this to update config
  updateAuthConfig, // Need this to save updated config
} from "@/lib/auth";
import { getIdentityService } from "@/lib/identity-runtime.mjs";
import { hasPermission } from "@/lib/identity-service.mjs";
import {
  clearSessionCookie,
  SESSION_COOKIE_NAME,
  setSessionCookie,
} from "@/lib/session-cookie.mjs";
import { createServerActionAuthenticator } from "@/lib/server-action-auth.mjs";
import { createUpdateActions } from "@/lib/update-actions.mjs";
import { formatTimeRange } from "@/lib/utils";
import {
  getDashboardTimeWindow,
  normalizeDashboardCameraNames,
} from "@/lib/dashboard-time-distribution.mjs";
import {
  querySystemLogIncident,
  querySystemLogText,
} from "@/lib/system-logs.mjs";
import { queryIntegrationIngressReceipts } from "@/lib/integration-ingress-receipts.mjs";
import { queryReadPipelineTimeline } from "@/lib/read-pipeline-timeline.mjs";
import {
  createLoggingIncident as createLoggingIncidentService,
  createLoggingRetentionPreview as createLoggingRetentionPreviewService,
  executeLoggingRetentionPreview as executeLoggingRetentionPreviewService,
  getLoggingRetentionOverview as loadLoggingRetentionOverview,
  normalizeLoggingIncidentInput,
  operationalFiltersForIncident,
} from "@/lib/logging-retention.mjs";
import { createComponentLogger } from "@/logging/logger";
import path from "path";
import fs from "fs/promises";
import split2 from "split2";
import fileStorage from "@/lib/fileStorage";
import {
  BlueIrisClient,
  normalizeBlueIrisSettings,
} from "@/lib/blue-iris.mjs";
import { BlueIrisVehicleFrameService } from "@/lib/blue-iris-vehicle-frame.mjs";
import { BlueIrisVehicleFrameRepository } from "@/lib/blue-iris-vehicle-frame-repository.mjs";
import {
  getBlueIrisVehicleFrameRuntime,
  wakeBlueIrisVehicleFrameWorker,
} from "@/lib/blue-iris-vehicle-frame-runtime.mjs";
import { normalizeEmailRecipients } from "@/lib/email-notifications.mjs";
import {
  clearStorageMaintenanceWebhookDestination as clearStorageMaintenanceWebhookDestinationService,
  executeStorageCleanup,
  replaceStorageMaintenanceWebhookDestination as replaceStorageMaintenanceWebhookDestinationService,
  runStorageMaintenancePreview,
  testStorageMaintenanceEmailRecipients as testStorageMaintenanceEmailRecipientsService,
  testStorageMaintenanceWebhookDestination as testStorageMaintenanceWebhookDestinationService,
  updateStorageMaintenanceSettings,
  updateAutomaticCleanupApproval as updateAutomaticCleanupApprovalService,
  acknowledgeAutomaticCleanup as acknowledgeAutomaticCleanupService,
  acknowledgeHostMaintenanceFailure,
  createDatabaseBackup as createDatabaseBackupService,
  createHostMaintenanceExecution,
  createHostMaintenancePreview,
  readDatabaseBackupRequest,
  readHostMaintenanceRequest,
  updateManualImageRetention,
  updateScheduledHostMaintenance,
} from "@/lib/storage-maintenance-service.mjs";

async function readServerActionSessionId() {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value || null;
}

const requireAuthenticatedSession = createServerActionAuthenticator({
  readSessionId: readServerActionSessionId,
  verifySession: getSessionPrincipal,
});

async function requirePermission(permission) {
  const principal = await requireAuthenticatedSession();
  if (principal.mustChangePassword) {
    throw new Error("Password change required");
  }
  if (!hasPermission(principal, permission)) {
    throw new Error("Permission denied");
  }
  return principal;
}


function plateReviewActionFailure(error, fallback) {
  const safeCodes = new Set([
    "ALIAS_EXISTS",
    "ALIAS_NOT_FOUND",
    "ALIAS_REVIEW_MISMATCH",
    "INVALID_ACTION",
    "INVALID_PLATE",
    "INVALID_STATUS",
    "NOTHING_TO_REVERSE",
    "NO_MATCHING_READS",
    "PLATE_UNCHANGED",
    "READ_NOT_FOUND",
    "REASON_REQUIRED",
  ]);
  if (safeCodes.has(error?.code)) {
    return { success: false, error: error.message };
  }
  console.error(fallback, error);
  return { success: false, error: fallback };
}

function identityActionFailure(error, fallback) {
  const safeCodes = new Set([
    "CANNOT_DISABLE_SELF",
    "CANNOT_DELETE_SELF",
    "CANNOT_RESET_SELF",
    "IDENTITY_ALREADY_BOOTSTRAPPED",
    "INVALID_IDENTITY_INPUT",
    "INVALID_DELETE_CONFIRMATION",
    "INVALID_PASSWORD",
    "LAST_ADMINISTRATOR",
    "UNKNOWN_ROLE",
    "USER_NOT_FOUND",
  ]);
  if (safeCodes.has(error?.code)) return { success: false, error: error.message };
  if (error?.code === "23505") {
    return { success: false, error: "That username is already in use." };
  }
  console.error(fallback);
  return { success: false, error: fallback };
}

const updateActions = createUpdateActions({
  authenticate: () => requirePermission("maintenance.manage"),
  backfillOccurrenceCounts,
  getTotalRecordsToMigrate,
  getRecordsToMigrate,
  migrateBase64ToFile: (...args) => fileStorage.migrateBase64ToFile(...args),
  updateImagePathsBatch,
  clearImageDataBatch,
  markUpdateComplete,
  verifyImageMigration,
});

export async function handleGetTags() {
  await requirePermission("plate.read");
  return await dbGetTags();
}

export async function handleCreateTag(tagName, color) {
  await requirePermission("tag.manage");
  return await dbCreateTag(tagName, color);
}

export async function handleDeleteTag(tagName) {
  await requirePermission("tag.manage");
  return await dbDeleteTag(tagName);
}

export async function getDashboardMetrics(
  timeZone,
  startDate,
  endDate,
  cameraNames = []
) {
  await requirePermission("plate.read");
  try {
    const selectedCameras = normalizeDashboardCameraNames(cameraNames);
    const metrics = await getMetrics(startDate, endDate, selectedCameras);

    // Pre-initialize the hourCounts array
    const hourCounts = new Array(24).fill(0);

    // Single pass through the data to aggregate by hour
    if (metrics.time_data) {
      metrics.time_data.forEach((read) => {
        const timestamp = new Date(read.timestamp);
        const localTimestamp = new Date(
          timestamp.toLocaleString("en-US", { timeZone })
        );
        const localHour = localTimestamp.getHours();
        hourCounts[localHour] += read.frequency;
      });
    }

    // Convert to final format in one go
    const timeDistribution = hourCounts.map((frequency, hour_block) => ({
      hour_block,
      frequency,
    }));

    // Process tag stats
    const normalizeTagStats = (stats) => {
      const normalized = (stats || []).map((tag) => ({
        ...tag,
        count: Number.parseInt(tag.count, 10) || 0,
      }));
      const totalMatches = normalized.reduce(
        (sum, tag) => sum + tag.count,
        0
      );
      return normalized.map((tag) => ({
        ...tag,
        percentage:
          totalMatches > 0
            ? ((tag.count / totalMatches) * 100).toFixed(1)
            : "0.0",
      }));
    };
    const tagStats = normalizeTagStats(metrics.tag_stats);
    const tagReadStats = normalizeTagStats(metrics.tag_read_stats);

    // Process camera stats
    const cameraData = metrics.camera_counts || [];

    return {
      ...metrics,
      time_distribution: timeDistribution,
      camera_counts: cameraData,
      tagged_vehicles_count:
        Number.parseInt(metrics.tagged_vehicles_count, 10) || 0,
      tagged_reads_count: Number.parseInt(metrics.tagged_reads_count, 10) || 0,
      tag_stats: tagStats,
      tag_read_stats: tagReadStats,
    };
  } catch (error) {
    console.error("Error fetching dashboard metrics:", error);
    return {
      time_distribution: [],
      camera_counts: [],
      total_plates_count: 0,
      total_reads: 0,
      unique_plates: 0,
      new_plates_count: 0,
      suspicious_count: 0,
      tagged_vehicles_count: 0,
      tagged_reads_count: 0,
      top_plates: [],
      tag_stats: [],
      tag_read_stats: [],
    };
  }
}

export async function deleteTagFromPlate(formData) {
  await requirePermission("tag.manage");
  try {
    const plateNumber = formData.get("plateNumber");
    const tagName = formData.get("tagName");
    await removeTagFromPlate(plateNumber, tagName);
    return { success: true };
  } catch (error) {
    console.error("Error removing tag from plate:", error);
    return { success: false, error: "Failed to remove tag from plate" };
  }
}

export async function deletePlate(formData) {
  await requirePermission("known_plate.manage");
  try {
    const plateNumber = formData.get("plateNumber");
    await removeKnownPlate(plateNumber);
    return { success: true };
  } catch (error) {
    console.error("Error removing known plate:", error);
    return { success: false, error: "Failed to remove plate" };
  }
}

export async function deletePlateFromDB(formData) {
  await requirePermission("plate.delete");
  try {
    const plateNumber = formData.get("plateNumber");
    await removePlate(plateNumber);
    return { success: true };
  } catch (error) {
    console.error("Error removing known plate:", error);
    return { success: false, error: "Failed to remove plate" };
  }
}

export async function deletePlateRead(formData) {
  await requirePermission("plate.delete");
  try {
    const id = formData.get("id"); // use ID
    await removePlateRead(id);
    return { success: true };
  } catch (error) {
    console.error("Error removing plate read:", error); // Clarified error message
    return { success: false, error: "Failed to remove plate read" };
  }
}

export async function getKnownPlatesList() {
  await requirePermission("plate.read");
  try {
    return { success: true, data: await getKnownPlates() };
  } catch (error) {
    console.error("Error getting known plates:", error);
    return { success: false, error: "Failed to get known plates" };
  }
}

export async function getTags() {
  await requirePermission("plate.read");
  try {
    return { success: true, data: await getAvailableTags() };
  } catch (error) {
    console.error("Error getting tags:", error);
    return { success: false, error: "Failed to get tags" };
  }
}

export async function addTag(formData) {
  await requirePermission("tag.manage");
  try {
    const name = formData.get("name");
    const color = formData.get("color") || "#808080";
    const tag = await createTag(name, color);
    return { success: true, data: tag };
  } catch (error) {
    console.error("Error creating tag:", error);
    return { success: false, error: "Failed to create tag" };
  }
}

export async function updateTag(formData) {
  await requirePermission("tag.manage");
  try {
    const newName = formData.get("name");
    const color = formData.get("color");
    const originalName = formData.get("originalName");

    let updatedTag;

    if (originalName !== newName) {
      updatedTag = await updateTagName(originalName, newName);
    }

    updatedTag = await updateTagColor(updatedTag?.name || originalName, color);

    return { success: true, data: updatedTag };
  } catch (error) {
    console.error("Error updating tag:", error);
    return { success: false, error: "Failed to update tag" };
  }
}

export async function removeTag(formData) {
  await requirePermission("tag.manage");
  try {
    const name = formData.get("name");
    await deleteTag(name);
    return { success: true };
  } catch (error) {
    console.error("Error deleting tag:", error);
    return { success: false, error: "Failed to delete tag" };
  }
}

export async function addKnownPlate(formData) {
  await requirePermission("known_plate.manage");
  try {
    const plateNumber = formData.get("plateNumber");
    const name = formData.get("name");
    const notes = formData.get("notes") || null;

    const plate = await updateKnownPlate(plateNumber, { name, notes });
    return { success: true, data: plate };
  } catch (error) {
    console.error("Error adding known plate:", error);
    return { success: false, error: "Failed to add known plate" };
  }
}

export async function tagPlate(formData) {
  await requirePermission("tag.manage");
  try {
    const plateNumber = formData.get("plateNumber");
    const tagName = formData.get("tagName");

    // Check if tag already exists on plate
    const existingTags = await getTagsForPlate(plateNumber);
    if (existingTags.includes(tagName)) {
      return {
        success: false,
        error: `Tag "${tagName}" is already added to this plate`,
      };
    }

    await addTagToPlate(plateNumber, tagName);
    return { success: true };
  } catch (error) {
    console.error("Error adding tag to plate:", error);
    return { success: false, error: "Failed to add tag to plate" };
  }
}

export async function untagPlate(formData) {
  await requirePermission("tag.manage");
  try {
    const plateNumber = formData.get("plateNumber");
    const tagName = formData.get("tagName");
    await removeTagFromPlate(plateNumber, tagName);
    return { success: true };
  } catch (error) {
    console.error("Error removing tag from plate:", error);
    return { success: false, error: "Failed to remove tag from plate" };
  }
}

export async function getPlateHistoryData(plateNumber) {
  await requirePermission("plate.read");
  try {
    return { success: true, data: await getPlateHistory(plateNumber) };
  } catch (error) {
    console.error("Error getting plate history:", error);
    return { success: false, error: "Failed to get plate history" };
  }
}

export async function getPlates(
  page = 1,
  pageSize = 25,
  sortConfig = { key: "last_seen_at", direction: "desc" },
  filters = {}
) {
  await requirePermission("plate.read");
  try {
    const config = await getConfig();
    const result = await getAllPlates({
      page,
      pageSize,
      sortBy: sortConfig.key,
      sortDesc: sortConfig.direction === "desc",
      filters: {
        tags:
          Array.isArray(filters.tags) && filters.tags.length > 0
            ? filters.tags
            : filters.tag && filters.tag !== "all"
              ? [filters.tag]
              : [],
        dateRange: filters.dateRange,
        search: filters.search,
        matchMode:
          filters.matchMode || "balanced",
        matchingSettings: config.plateMatching,
        hourRange: filters.hourRange,
        cameraNames:
          Array.isArray(filters.cameraNames) && filters.cameraNames.length > 0
            ? filters.cameraNames
            : filters.cameraName
              ? [filters.cameraName]
              : [],
      },
    });
    return { success: true, ...result };
  } catch (error) {
    console.error("Error getting plates database:", error);
    return {
      success: false,
      error: "Failed to get plates database",
      data: [],
      pagination: {
        total: 0,
        pageCount: 0,
        page: 1,
        pageSize: 25,
      },
    };
  }
}

export async function getLatestPlateReads({
  page = 1,
  pageSize = 25,
  readId = "",
  search = "",
  fuzzySearch = false,
  matchMode = "balanced",
  tag = "all",
  tags = [],
  dateRange = null,
  timestampRange = null,
  hourRange = null,
  timeZone = "",
  cameraName = "",
  cameraNames = [],
  reviewStatuses = [],
  directionLabels = [],
  dashboardMetric = "",
  sortField = "",
  sortDirection = "",
} = {}) {
  await requirePermission("plate.read");
  try {
    const config = await getConfig();
    const result = await getPlateReads({
      page,
      pageSize,
      filters: {
        readId,
        plateNumber: search,
        matchMode:
          fuzzySearch && !matchMode ? "balanced" : matchMode || "balanced",
        matchingSettings: config.plateMatching,
        tags:
          Array.isArray(tags) && tags.length > 0
            ? tags
            : tag !== "all"
              ? [tag]
              : [],
        dateRange,
        timestampRange,
        hourRange,
        timeZone,
        cameraNames:
          Array.isArray(cameraNames) && cameraNames.length > 0
            ? cameraNames
            : cameraName
              ? [cameraName]
              : [],
        reviewStatuses: Array.isArray(reviewStatuses) ? reviewStatuses : [],
        directionLabels: Array.isArray(directionLabels) ? directionLabels : [],
        dashboardMetric,
      },
      sort: {
        field: sortField,
        direction: sortDirection,
      },
    });

    return {
      data: result.data,
      pagination: {
        page,
        pageSize,
        total: result.pagination.total,
        pageCount: result.pagination.pageCount,
      },
    };
  } catch (error) {
    console.error("Error fetching plate reads:", error);
    return {
      data: [],
      pagination: {
        page,
        pageSize,
        total: 0,
        pageCount: 0,
      },
    };
  }
}

export async function fetchPlateInsights(formDataOrPlateNumber, timeZone) {
  await requirePermission("plate.read");
  const config = await getConfig();
  try {
    let plateNumber;
    if (formDataOrPlateNumber instanceof FormData) {
      plateNumber = formDataOrPlateNumber.get("plateNumber");
    } else {
      plateNumber = formDataOrPlateNumber;
    }

    if (!plateNumber) {
      return { success: false, error: "Plate number is required" };
    }

    const insights = await getPlateInsights(plateNumber);

    // Create an array with all 24 hour blocks
    const hourCounts = new Array(24).fill(0);

    if (insights.time_data) {
      insights.time_data.forEach((read) => {
        const timestamp = new Date(read.timestamp);
        const localTimestamp = new Date(
          timestamp.toLocaleString("en-US", { timeZone: timeZone || "UTC" })
        );
        const localHour = localTimestamp.getHours();
        hourCounts[localHour] += read.frequency;
      });
    }

    const timeDistribution = hourCounts.map((frequency, hour) => ({
      hour_block: hour, // Pass the raw hour
      frequency,
    }));

    const mostActiveTime =
      timeDistribution.length > 0
        ? timeDistribution.reduce((max, current) =>
            current.frequency > max.frequency ? current : max
          ).hour_block
        : "No data available";

    return {
      success: true,
      data: {
        plateNumber: insights.plate_number,
        knownName: insights.known_name,
        notes: insights.notes,
        summary: {
          firstSeen: insights.first_seen_at,
          lastSeen: insights.last_seen_at,
          totalOccurrences: insights.total_occurrences,
        },
        tags: insights.tags || [],
        timeDistribution: timeDistribution,
        recentReads: insights.recent_reads || [],
        mostActiveTime: mostActiveTime,
      },
      timeFormat: config.general.timeFormat || 12,
    };
  } catch (error) {
    console.error("Failed to get plate insights:", error);
    return { success: false, error: "Failed to get plate insights" };
  }
}

export async function alterPlateFlag(formData) {
  await requirePermission("plate.review");
  try {
    const plateNumber = formData.get("plateNumber");
    const flagged = formData.get("flagged") === "true";
    const reason = formData.has("monitorReason")
      ? formData.get("monitorReason")
      : undefined;
    const priority = formData.has("monitorPriority")
      ? formData.get("monitorPriority")
      : undefined;

    const result = await togglePlateFlag(plateNumber, flagged, {
      reason,
      priority,
    });

    revalidatePath("/flagged");
    revalidatePath("/known_plates");
    revalidatePath("/database");

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    console.error("Failed to toggle plate flag:", error);
    return {
      success: false,
      error: "Failed to toggle plate flag",
    };
  }
}

export async function getFlagged() {
  await requirePermission("plate.read");
  try {
    const plates = await getFlaggedPlates();
    return plates;
  } catch (error) {
    console.error("Error fetching flagged plates:", error);
    return [];
  }
}

export async function getNotificationRuleMigrationPreview() {
  await requirePermission("notification.manage");
  try {
    const preview = await loadNotificationMigrationPreview();
    return { success: true, data: preview };
  } catch (error) {
    console.error("Error building notification rule migration preview:", error);
    return {
      success: false,
      error: "Failed to build notification rule migration preview",
    };
  }
}

export async function applyDisabledNotificationRuleMigration(formData) {
  const principal = await requirePermission("notification.manage");
  if (formData?.get("confirmation") !== "create_disabled_rules") {
    return {
      success: false,
      error: "Confirm that the copied rules will remain disabled before continuing.",
    };
  }
  try {
    const data = await applyDisabledNotificationMigration({ actor: principal });
    revalidatePath("/notifications");
    return { success: true, data };
  } catch (error) {
    console.error("Error creating disabled unified notification rules:", error);
    return {
      success: false,
      error: "Failed to create disabled unified notification rules",
    };
  }
}

export async function getUnifiedNotificationRuleReview() {
  await requirePermission("notification.manage");
  try {
    const review = await loadNotificationShadowReview();
    return { success: true, data: review };
  } catch (error) {
    console.error("Error building unified notification shadow review:", error);
    return { success: false, error: "Failed to build unified rule shadow review" };
  }
}

const RULE_BUILDER_SAFE_MESSAGES = new Set([
  "Rule draft payload is invalid",
  "Rule name is required",
  "Rule name is too long",
  "Description is too long",
  "Cooldown must be between 0 and 2678400",
  "Add at least one condition",
  "Add at least one notification action",
  "Select a supported condition type",
  "Select at least one tag",
  "Select valid tag",
  "Select at least one camera",
  "Select valid camera",
  "Plate number is required",
  "Confidence must be between 0 and 100",
  "Schedule start and end times are required",
  "Schedule start is required",
  "Schedule end is required",
  "Select valid schedule weekdays",
  "Schedule time zone is required",
  "Select a valid schedule time zone",
  "Rule time zone is required",
  "Select a valid rule time zone",
  "Quiet-hours start is required",
  "Quiet-hours end is required",
  "Select valid quiet-hour weekdays",
  "Quiet-hours time zone is required",
  "Select a valid quiet-hours time zone",
  "Evaluation interval must be between 60 and 86400",
  "Camera activity rules must select at least one camera",
  "Camera activity rules need a camera read-count condition with a time period",
  "Select MQTT or Pushover for each action",
  "MQTT broker must be between 1 and 2147483647",
  "MQTT fixed topic is required",
  "MQTT publish topics cannot contain wildcard characters",
  "Pushover priority must be between -2 and 2",
  "Select a valid notification rule",
  "The notification rule was not found",
  "Migrated rules must use the guarded migration workflow",
  "Disable the rule before editing it",
  "Rule name confirmation does not match",
  "Wait for the in-progress delivery before deleting this rule",
  "The rule needs conditions and an action before activation",
  "Enable and configure Pushover before activating this rule",
  "Enable MQTT and every selected broker before activating this rule",
]);

function notificationRuleBuilderFailure(error, fallback) {
  console.error(fallback, error);
  return {
    success: false,
    error: error instanceof Error && RULE_BUILDER_SAFE_MESSAGES.has(error.message)
      ? error.message
      : fallback,
  };
}

export async function getNotificationRuleBuilderOverview() {
  await requirePermission("notification.manage");
  try {
    return { success: true, data: await loadNotificationRuleBuilderOverview() };
  } catch (error) {
    return notificationRuleBuilderFailure(error, "Failed to load the notification rule builder");
  }
}

export async function getNotificationOperationsOverview() {
  await requirePermission("notification.manage");
  try {
    return { success: true, data: await loadNotificationOperationsOverview() };
  } catch (error) {
    console.error("Failed to load notification operations", error);
    return { success: false, error: "Failed to load notification operations" };
  }
}

export async function saveNotificationRuleBuilderDraft(formData) {
  const principal = await requirePermission("notification.manage");
  if (formData?.get("confirmation") !== "save_disabled_notification_rule") {
    return { success: false, error: "Confirm that the rule will remain disabled." };
  }
  try {
    const draft = parseNotificationRuleDraft(formData.get("draft"));
    const id = Number(formData.get("ruleId"));
    const data = Number.isInteger(id) && id > 0
      ? await updateNotificationRuleBuilderDraft({ id, draft, actor: principal })
      : await createNotificationRuleDraft({ draft, actor: principal });
    revalidatePath("/notifications");
    return { success: true, data };
  } catch (error) {
    return notificationRuleBuilderFailure(error, "Failed to save the disabled notification rule");
  }
}

export async function previewNotificationRuleBuilderDraft(formData) {
  await requirePermission("notification.manage");
  try {
    const data = await previewNotificationRuleBuilder({
      id: formData.get("ruleId"),
      limit: formData.get("limit") || 25,
    });
    return { success: true, data };
  } catch (error) {
    return notificationRuleBuilderFailure(error, "Failed to preview the notification rule");
  }
}

export async function toggleNotificationRuleBuilder(formData) {
  const principal = await requirePermission("notification.manage");
  const enabled = formData?.get("enabled") === "true";
  const expected = enabled ? "activate_notification_rule" : "deactivate_notification_rule";
  if (formData?.get("confirmation") !== expected) {
    return { success: false, error: `Confirm that you want to ${enabled ? "activate" : "deactivate"} this rule.` };
  }
  try {
    const data = await setNotificationRuleBuilderEnabled({
      id: formData.get("ruleId"),
      enabled,
      actor: principal,
    });
    revalidatePath("/notifications");
    return { success: true, data };
  } catch (error) {
    return notificationRuleBuilderFailure(error, `Failed to ${enabled ? "activate" : "deactivate"} the notification rule`);
  }
}

export async function deleteNotificationRuleBuilder(formData) {
  const principal = await requirePermission("notification.manage");
  if (formData?.get("confirmation") !== "delete_disabled_notification_rule") {
    return { success: false, error: "Confirm that you want to delete this disabled rule." };
  }
  try {
    const data = await deleteNotificationRuleBuilderRule({
      id: formData.get("ruleId"),
      expectedName: formData.get("ruleName"),
      actor: principal,
    });
    revalidatePath("/notifications");
    return { success: true, data };
  } catch (error) {
    return notificationRuleBuilderFailure(error, "Failed to delete the notification rule");
  }
}

export async function approveUnifiedNotificationRuleReview(formData) {
  const principal = await requirePermission("notification.manage");
  const approvalMode = formData?.get("approvalMode") === "intentional_expansion"
    ? "intentional_expansion"
    : "parity";
  const expectedConfirmation = approvalMode === "intentional_expansion"
    ? "approve_intentional_expansion"
    : "approve_disabled_shadow_review";
  if (formData?.get("confirmation") !== expectedConfirmation) {
    return {
      success: false,
      error: "Confirm that this approval records the current disabled-rule evidence only.",
    };
  }
  try {
    const data = await recordNotificationShadowReviewApproval({
      ruleId: formData.get("ruleId"),
      approvalMode,
      actor: principal,
    });
    revalidatePath("/notifications");
    return { success: true, data };
  } catch (error) {
    console.error("Error approving unified notification shadow review:", error);
    const safeMessages = new Set([
      "Select a valid unified rule to approve",
      "The migrated unified rule was not found",
      "Approval blocked because the rule, channel, or action is not safely disabled",
      "Approval requires at least one relevant recent read",
      "Resolve shadow comparison mismatches before approval",
      "Approval requires at least one positive legacy and unified match",
      "Select a valid unified rule approval mode",
      "Intentional expansion cannot approve a legacy match that unified logic would lose",
      "Intentional expansion requires at least one real read matched only by unified logic",
    ]);
    return {
      success: false,
      error:
        error instanceof Error && safeMessages.has(error.message)
          ? error.message
          : "Failed to record shadow review approval",
    };
  }
}

function commaSeparated(value) {
  return [...new Set(String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
}

export async function updateDisabledUnifiedNotificationRule(formData) {
  const principal = await requirePermission("notification.manage");
  if (formData?.get("confirmation") !== "save_disabled_rule_draft") {
    return { success: false, error: "Confirm that the unified rule and delivery remain disabled." };
  }
  try {
    const data = await updateNotificationRuleDraft({
      ruleId: formData.get("ruleId"),
      requireKnownPlate: formData.get("requireKnownPlate") === "true",
      tags: commaSeparated(formData.get("tags")),
      cameras: commaSeparated(formData.get("cameras")),
      actor: principal,
    });
    revalidatePath("/notifications");
    return { success: true, data };
  } catch (error) {
    console.error("Error updating disabled unified notification rule:", error);
    const safeMessages = new Set([
      "Select a valid unified rule to edit",
      "The migrated unified rule was not found",
      "Only migrated MQTT tag rules can be edited here",
      "Disable the unified rule before editing its conditions",
      "Rule editing requires the rule, channel, and actions to remain disabled",
      "This rule uses a condition structure that is not editable here",
      "Only migrated tag-and-camera rules can be edited here",
      "Select at least one tag",
      "Select valid tag",
      "Select at least one camera",
      "Select valid camera",
    ]);
    return {
      success: false,
      error: error instanceof Error && safeMessages.has(error.message)
        ? error.message
        : "Failed to update the disabled unified notification rule",
    };
  }
}

export async function simulateDisabledUnifiedNotificationRule(formData) {
  await requirePermission("notification.manage");
  try {
    const data = await simulateNotificationRuleDraft({
      ruleId: formData.get("ruleId"),
      plateNumber: formData.get("plateNumber"),
      cameraName: formData.get("cameraName"),
      tags: commaSeparated(formData.get("testTags")),
      knownPlate: formData.get("knownPlate") === "true",
    });
    return { success: true, data };
  } catch (error) {
    console.error("Error simulating disabled unified notification rule:", error);
    const safeMessages = new Set([
      "Select a valid unified rule to test",
      "The migrated unified rule was not found",
      "Only migrated MQTT tag rules can be edited here",
      "Disable the unified rule before editing its conditions",
      "Rule editing requires the rule, channel, and actions to remain disabled",
      "This rule uses a condition structure that is not editable here",
      "Only migrated tag-and-camera rules can be edited here",
      "Enter a valid test plate number",
      "Enter a valid test camera",
      "Enter valid test tags",
    ]);
    return {
      success: false,
      error: error instanceof Error && safeMessages.has(error.message)
        ? error.message
        : "Failed to simulate the disabled unified notification rule",
    };
  }
}

export async function getUnifiedNotificationCutoverPreview() {
  await requirePermission("notification.manage");
  try {
    const preview = await loadNotificationCutoverPreview();
    return { success: true, data: preview };
  } catch (error) {
    console.error("Error building unified notification cutover preview:", error);
    return { success: false, error: "Failed to build unified notification cutover preview" };
  }
}

export async function getNotificationLegacyFinalizationPreview() {
  await requirePermission("notification.manage");
  try {
    return { success: true, data: await loadNotificationLegacyFinalizationPreview() };
  } catch (error) {
    console.error("Error building legacy notification finalization preview:", error);
    return { success: false, error: "Failed to verify legacy notification finalization readiness" };
  }
}

const LEGACY_FINALIZATION_SAFE_MESSAGES = new Set([
  "No cutover legacy notification rules are available to finalize",
  "Every legacy replacement must be active with a verified post-cutover delivery before finalization",
  "A legacy notification source changed during finalization",
]);

export async function finalizeLegacyNotificationMigration(formData) {
  const principal = await requirePermission("notification.manage");
  if (formData?.get("confirmation") !== "finalize_legacy_notification_migration") {
    return { success: false, error: "Confirm permanent legacy notification finalization before continuing." };
  }
  try {
    const data = await finalizeNotificationLegacyMigration({ actor: principal });
    revalidatePath("/notifications");
    revalidatePath("/mqtt");
    return { success: true, data };
  } catch (error) {
    console.error("Error finalizing legacy notification migration:", error);
    return {
      success: false,
      error: error instanceof Error && LEGACY_FINALIZATION_SAFE_MESSAGES.has(error.message)
        ? error.message
        : "Failed to finalize the legacy notification migration",
    };
  }
}

const CUTOVER_SAFE_MESSAGES = new Set([
  "Select a valid unified rule to cut over",
  "Select a valid unified rule to roll back",
  "The migrated unified rule was not found",
  "The legacy source rule was not found",
  "The unified rule has no delivery actions",
  "Cutover requires an active legacy rule and a fully disabled unified rule",
  "Rollback requires an active unified rule and a disabled legacy rule",
  "A live unified delivery adapter is not available for this channel",
  "Unified MQTT destination no longer matches the legacy source rule",
  "Unified Pushover priority no longer matches the legacy source rule",
  "Cutover requires current administrator-approved shadow evidence",
  "Cutover requires zero mismatches and at least one positive match",
  "Cutover requires an approved expansion with no lost legacy matches",
]);

export async function cutoverUnifiedNotificationRule(formData) {
  const principal = await requirePermission("notification.manage");
  if (formData?.get("confirmation") !== "cutover_one_rule") {
    return { success: false, error: "Confirm the guarded one-rule cutover before continuing." };
  }
  try {
    const data = await cutoverNotificationRule({
      ruleId: formData.get("ruleId"),
      actor: principal,
    });
    revalidatePath("/notifications");
    return { success: true, data };
  } catch (error) {
    console.error("Error cutting over unified notification rule:", error);
    return {
      success: false,
      error:
        error instanceof Error && CUTOVER_SAFE_MESSAGES.has(error.message)
          ? error.message
          : "Failed to cut over unified notification rule",
    };
  }
}

export async function rollbackUnifiedNotificationRule(formData) {
  const principal = await requirePermission("notification.manage");
  if (formData?.get("confirmation") !== "rollback_one_rule") {
    return { success: false, error: "Confirm the one-rule rollback before continuing." };
  }
  try {
    const data = await rollbackNotificationRule({
      ruleId: formData.get("ruleId"),
      actor: principal,
    });
    revalidatePath("/notifications");
    return { success: true, data };
  } catch (error) {
    console.error("Error rolling back unified notification rule:", error);
    return {
      success: false,
      error:
        error instanceof Error && CUTOVER_SAFE_MESSAGES.has(error.message)
          ? error.message
          : "Failed to roll back unified notification rule",
    };
  }
}

const RETIRE_ORPHAN_SAFE_MESSAGES = new Set([
  "Select a valid orphaned unified rule to retire",
  "The migrated unified rule was not found",
  "Retirement requires a removed legacy source rule",
  "Retirement requires the unified rule, channel, and actions to remain disabled",
  "A migration with cutover history cannot be retired",
]);

export async function retireOrphanedUnifiedNotificationRule(formData) {
  const principal = await requirePermission("notification.manage");
  if (formData?.get("confirmation") !== "retire_orphaned_migration") {
    return {
      success: false,
      error: "Confirm retirement of the disabled orphaned migration before continuing.",
    };
  }
  try {
    const data = await retireOrphanedNotificationRule({
      ruleId: formData.get("ruleId"),
      actor: principal,
    });
    revalidatePath("/notifications");
    return { success: true, data };
  } catch (error) {
    console.error("Error retiring orphaned unified notification migration:", error);
    return {
      success: false,
      error:
        error instanceof Error && RETIRE_ORPHAN_SAFE_MESSAGES.has(error.message)
          ? error.message
          : "Failed to retire the orphaned notification migration",
    };
  }
}

export async function loginAction(formData) {
  const username = String(formData.get("username") || "").trim();
  const password = formData.get("password");

  if (!password) {
    return { error: "Password is required" };
  }

  try {
    const headersList = await headers();
    const userAgent = headersList.get("user-agent") || "Unknown Device";
    const identityService = getIdentityService();
    const identityState = await identityService.getBootstrapState();

    if (identityState.bootstrapped) {
      if (!username) return { error: "Invalid username or password" };
      const namedLogin = await identityService.authenticate({
        username,
        password,
        userAgent,
      });
      if (!namedLogin) return { error: "Invalid username or password" };
      if (namedLogin.rateLimited) {
        return {
          error: "Too many unsuccessful attempts. Try again later.",
          retryAfterSeconds: namedLogin.retryAfterSeconds,
        };
      }

      const cookieStore = await cookies();
      setSessionCookie(cookieStore, namedLogin.sessionToken);
      return { success: true };
    }

    if (username) return { error: "Invalid username or password" };

    const config = await getAuthConfig(); // Get current config to check hash type
    const storedHash = config.password;

    const isPasswordValid = await verifyPassword(password); // This verifies against whatever hash type is stored

    if (!isPasswordValid) {
      return { error: "Invalid username or password" };
    }

    // --- Password Migration Logic ---
    // If the stored password is an old SHA256 hash (doesn't start with '$2'),
    // re-hash the provided plaintext password to bcrypt and save it.
    if (!storedHash.startsWith("$2")) {
      const newBcryptHash = await hashPasswordBcrypt(password);
      config.password = newBcryptHash;
      await updateAuthConfig(config); // Save the updated config with the new hash
    }
    // --- End Password Migration Logic ---

    const sessionId = await createSession(userAgent);

    const cookieStore = await cookies();
    setSessionCookie(cookieStore, sessionId);

    return { success: true };
  } catch (error) {
    console.error("Login failed");

    if (
      error &&
      typeof error.digest === "string" &&
      error.digest.startsWith("NEXT_REDIRECT")
    ) {
      throw error;
    }

    return { error: "An unexpected error occurred during login" };
  }
}

export async function getIdentityAdminState() {
  const principal = await requireAuthenticatedSession();
  const identityService = getIdentityService();
  const state = await identityService.getBootstrapState();
  const canManageUsers =
    principal.authMode === "named" &&
    !principal.mustChangePassword &&
    hasPermission(principal, "system.manage_users");
  const users =
    state.bootstrapped && canManageUsers
      ? await identityService.listUsers()
      : [];
  return {
    ...state,
    users,
    currentUser: {
      id: principal.id,
      username: principal.username,
      displayName: principal.displayName,
      roles: principal.roles,
      authMode: principal.authMode,
      mustChangePassword: Boolean(principal.mustChangePassword),
    },
    canManageUsers,
  };
}

export async function getCurrentAccess() {
  const principal = await requireAuthenticatedSession();
  const permissions = principal.mustChangePassword
    ? []
    : [...(principal.permissions || [])];
  return {
    currentUser: {
      id: principal.id,
      username: principal.username,
      displayName: principal.displayName,
      roles: principal.roles,
      authMode: principal.authMode,
      mustChangePassword: Boolean(principal.mustChangePassword),
    },
    permissions,
  };
}

export async function bootstrapNamedAdministrator(formData) {
  const principal = await requireAuthenticatedSession();
  if (principal.authMode !== "legacy") {
    return { success: false, error: "Named accounts are already active." };
  }
  const currentPassword = formData.get("currentPassword");
  if (!(await verifyPassword(currentPassword))) {
    return { success: false, error: "Incorrect current password." };
  }

  try {
    const headersList = await headers();
    const result = await getIdentityService().bootstrapOwner({
      username: formData.get("username"),
      displayName: formData.get("displayName"),
      password: currentPassword,
      userAgent: headersList.get("user-agent") || "Unknown Device",
    });
    const cookieStore = await cookies();
    const legacySessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (legacySessionId) await invalidateSession(legacySessionId);
    setSessionCookie(cookieStore, result.sessionToken);
    revalidatePath("/settings");
    return { success: true, user: result.user };
  } catch (error) {
    return identityActionFailure(error, "Unable to create the named administrator.");
  }
}

export async function createNamedUser(formData) {
  const principal = await requirePermission("system.manage_users");
  const password = formData.get("password");
  if (password !== formData.get("confirmPassword")) {
    return {
      success: false,
      error: "Temporary password and confirmation do not match.",
    };
  }
  try {
    const user = await getIdentityService().createUser({
      actor: principal,
      username: formData.get("username"),
      displayName: formData.get("displayName"),
      password,
      role: formData.get("role"),
    });
    revalidatePath("/settings");
    return { success: true, user };
  } catch (error) {
    return identityActionFailure(error, "Unable to create the user.");
  }
}

export async function setNamedUserStatus(formData) {
  const principal = await requirePermission("system.manage_users");
  try {
    await getIdentityService().setUserStatus({
      actor: principal,
      userId: formData.get("userId"),
      status: formData.get("status"),
    });
    revalidatePath("/settings");
    return { success: true };
  } catch (error) {
    return identityActionFailure(error, "Unable to change the account status.");
  }
}

export async function setNamedUserRole(formData) {
  const principal = await requirePermission("system.manage_users");
  try {
    await getIdentityService().setUserRole({
      actor: principal,
      userId: formData.get("userId"),
      role: formData.get("role"),
    });
    revalidatePath("/settings");
    return { success: true };
  } catch (error) {
    return identityActionFailure(error, "Unable to change the user role.");
  }
}

export async function resetNamedUserPassword(formData) {
  const principal = await requirePermission("system.manage_users");
  const password = formData.get("password");
  if (password !== formData.get("confirmPassword")) {
    return { success: false, error: "Password confirmation does not match." };
  }
  try {
    await getIdentityService().resetUserPassword({
      actor: principal,
      userId: formData.get("userId"),
      password,
      currentPassword: formData.get("currentPassword"),
    });
    return { success: true };
  } catch (error) {
    return identityActionFailure(error, "Unable to reset the user password.");
  }
}

export async function deleteNamedUser(formData) {
  const principal = await requirePermission("system.manage_users");
  try {
    await getIdentityService().deleteUser({
      actor: principal,
      userId: formData.get("userId"),
      confirmUsername: formData.get("confirmUsername"),
      currentPassword: formData.get("currentPassword"),
    });
    revalidatePath("/settings");
    return { success: true };
  } catch (error) {
    return identityActionFailure(error, "Unable to delete the user.");
  }
}

export async function logoutAction() {
  "use server";

  const cookieStore = await cookies();
  const sessionId = cookieStore.get("session")?.value;

  if (sessionId) {
    await invalidateSession(sessionId);
  }

  clearSessionCookie(cookieStore);

  redirect("/login");
}

export async function getSettings() {
  await requirePermission("system.manage_settings");
  const config = await getConfig();
  return sanitizeSettingsForClient(config);
}

function storageMaintenanceFailure(error, fallback) {
  const candidate = String(error?.message || "").trim().slice(0, 1000);
  const safeMessages = [
    /^Warning must be at least 1%/,
    /^Enter at least one email recipient$/,
    /^Enter no more than \d+ valid email recipients$/,
    /^Enter a valid webhook URL$/,
    /^Webhook URLs must use HTTP\(S\)/,
    /^Configure a maintenance webhook destination before enabling maintenance webhooks\.$/,
    /^No maintenance webhook destination is configured\.$/,
    /^SMTP did not accept any maintenance test recipients\.$/,
    /^Type DELETE DERIVED ORPHANS to confirm cleanup$/,
    /^Cleanup preview token is invalid or has already been used$/,
    /^Cleanup preview token has expired$/,
    /^Cleanup confirmation does not match this preview$/,
    /^Another storage cleanup operation is already running$/,
    /^Type ENABLE AUTOMATIC DERIVED CLEANUP to activate automatic cleanup$/,
    /^Type ACKNOWLEDGE AUTOMATIC CLEANUP FAILURE to acknowledge the automatic cleanup failure$/,
    /^Automatic cleanup is not suspended$/,
    /^Automatic cleanup suspension is missing its failed-run provenance$/,
    /^Run a fresh, successful storage reconciliation before acknowledging this failure$/,
    /^Automatic cleanup approval requires an authenticated Administrator$/,
    /^Unsupported host maintenance category$/,
    /^Host maintenance requires an authenticated actor$/,
    /^Host maintenance request is invalid$/,
    /^A host maintenance request is already pending or running for this category$/,
    /^Host maintenance preview is incomplete, expired, or invalid$/,
    /^The fixed host maintenance worker is unavailable or stale$/,
    /^Scheduled unused-image pruning is unsupported until independently approved$/,
    /^Rollback-backup deletion is disabled until catalog-bound approval is implemented$/,
    /^Type SET IMAGE RETIREMENT GRACE to update image retention$/,
    /^Type (?:PRUNE UNUSED ALPR BUILD CACHE|PRUNE RETIRED ALPR IMAGES|PRUNE EXPIRED VERIFIED ROLLOUT BACKUPS) to request this category$/,
    /^Type ENABLE SCHEDULED (?:DOCKER CACHE PRUNING|UNUSED ALPR IMAGE PRUNING|ROLLOUT BACKUP RETENTION) to activate scheduled/,
    /^Type ACKNOWLEDGE (?:DOCKER CACHE|UNUSED IMAGE|ROLLOUT BACKUP) FAILURE to acknowledge this failure$/,
    /^Category circuit breaker is not open$/,
    /^A fresh worker inventory is required before acknowledgement$/,
    /^No failed destructive intent is available for acknowledgement$/,
    /^A post-failure worker inventory is required before acknowledgement$/,
    /^Category circuit breaker is open; acknowledge it before requesting cleanup$/,
    /^Queue a fresh host maintenance preview after acknowledging this failure$/,
  ];
  const safe = safeMessages.some((pattern) => pattern.test(candidate));
  if (!safe) {
    console.error("Storage maintenance action failed", {
      errorName: String(error?.name || "Error").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 100),
      errorCode: /^[A-Z0-9_]{1,100}$/.test(String(error?.code || "")) ? String(error.code) : undefined,
    });
  }
  return {
    success: false,
    error: safe ? candidate : fallback,
  };
}

export async function saveStorageMaintenanceSettings(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const warningPercent = Number(input.warningPercent);
    const criticalPercent = Number(input.criticalPercent);
    if (
      !Number.isFinite(warningPercent) ||
      !Number.isFinite(criticalPercent) ||
      warningPercent < 1 ||
      criticalPercent > 99.9 ||
      warningPercent >= criticalPercent
    ) {
      throw new Error("Warning must be at least 1% and lower than the critical threshold.");
    }
    const emailRecipients = input.emailRecipients?.length || input.emailEnabled
      ? normalizeEmailRecipients(input.emailRecipients)
      : [];
    const data = await updateStorageMaintenanceSettings({
      actor: principal,
      input: {
        ...input,
        warningPercent,
        criticalPercent,
        emailEnabled: input.emailEnabled === true,
        emailRecipients,
        webhookEnabled: input.webhookEnabled === true,
        cleanupEnabled: false,
        automaticCategories: [],
      },
    });
    revalidatePath("/settings/data-privacy");
    return { success: true, data };
  } catch (error) {
    return storageMaintenanceFailure(error, "Unable to save storage maintenance settings.");
  }
}

export async function replaceStorageMaintenanceWebhookDestination(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const data = await replaceStorageMaintenanceWebhookDestinationService({
      actor: principal,
      webhookUrl: String(input.webhookUrl || ""),
    });
    revalidatePath("/settings/data-privacy");
    return { success: true, data };
  } catch (error) {
    return storageMaintenanceFailure(error, "Unable to replace the maintenance webhook destination.");
  }
}

export async function testStorageMaintenanceEmailRecipients(input = {}) {
  await requirePermission("maintenance.manage");
  try {
    const recipients = normalizeEmailRecipients(input.recipients);
    const data = await testStorageMaintenanceEmailRecipientsService({ recipients });
    return { success: true, data };
  } catch (error) {
    return storageMaintenanceFailure(error, "Unable to deliver the maintenance email test.");
  }
}

export async function testStorageMaintenanceWebhookDestination(input = {}) {
  await requirePermission("maintenance.manage");
  try {
    const data = await testStorageMaintenanceWebhookDestinationService({
      webhookUrl: String(input.webhookUrl || ""),
    });
    return { success: true, data };
  } catch (error) {
    return storageMaintenanceFailure(error, "Unable to deliver the maintenance webhook test.");
  }
}

export async function clearStorageMaintenanceWebhookDestination() {
  const principal = await requirePermission("maintenance.manage");
  try {
    const data = await clearStorageMaintenanceWebhookDestinationService({ actor: principal });
    revalidatePath("/settings/data-privacy");
    return { success: true, data };
  } catch (error) {
    return storageMaintenanceFailure(error, "Unable to clear the maintenance webhook destination.");
  }
}

export async function previewStorageCleanup() {
  const principal = await requirePermission("maintenance.manage");
  try {
    const data = await runStorageMaintenancePreview({ actor: principal });
    revalidatePath("/settings/data-privacy");
    return { success: true, data };
  } catch (error) {
    return storageMaintenanceFailure(error, "Unable to create a storage cleanup preview.");
  }
}

export async function runConfirmedStorageCleanup(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const data = await executeStorageCleanup({
      actor: principal,
      previewToken: String(input.previewToken || ""),
      confirmation: String(input.confirmation || ""),
    });
    revalidatePath("/settings/data-privacy");
    return { success: true, data };
  } catch (error) {
    return storageMaintenanceFailure(error, "Unable to run storage cleanup.");
  }
}

export async function setAutomaticStorageCleanupApproval(input = {}) {
  const principal = await requirePermission("maintenance.automatic_cleanup.approve");
  try {
    const data = await updateAutomaticCleanupApprovalService({ actor: principal, input });
    revalidatePath("/settings/data-privacy");
    return { success: true, data };
  } catch (error) {
    return storageMaintenanceFailure(error, "Unable to update automatic cleanup approval.");
  }
}

export async function acknowledgeAutomaticStorageCleanupFailure(input = {}) {
  const principal = await requirePermission("maintenance.automatic_cleanup.approve");
  try {
    const data = await acknowledgeAutomaticCleanupService({
      actor: principal,
      confirmation: String(input.confirmation || ""),
    });
    revalidatePath("/settings/data-privacy");
    return { success: true, data };
  } catch (error) {
    return storageMaintenanceFailure(error, "Unable to acknowledge automatic cleanup failure.");
  }
}

export async function previewHostMaintenance(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    return { success: true, data: await createHostMaintenancePreview({ actor: principal, category: input.category }) };
  } catch (error) { return storageMaintenanceFailure(error, "Unable to queue host maintenance preview."); }
}

export async function createDatabaseBackup() {
  const principal = await requirePermission("maintenance.manage");
  try {
    const data = await createDatabaseBackupService({ actor: principal });
    revalidatePath("/settings/data-privacy/cleanup");
    return { success: true, data };
  } catch (error) { return storageMaintenanceFailure(error, "Unable to queue database backup."); }
}

export async function refreshDatabaseBackup(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    return { success: true, data: await readDatabaseBackupRequest({ actor: principal, requestId: input.requestId }) };
  } catch (error) { return storageMaintenanceFailure(error, "Unable to read database-backup status."); }
}

export async function refreshHostMaintenancePreview(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    return { success: true, data: await readHostMaintenanceRequest({ actor: principal, requestId: input.requestId }) };
  } catch (error) { return storageMaintenanceFailure(error, "Unable to read host maintenance preview."); }
}

export async function runConfirmedHostMaintenance(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const data = await createHostMaintenanceExecution({ actor: principal, requestId: input.requestId, previewToken: String(input.previewToken || ""), confirmation: String(input.confirmation || "") });
    revalidatePath("/settings/data-privacy");
    return { success: true, data };
  } catch (error) { return storageMaintenanceFailure(error, "Unable to queue host maintenance execution."); }
}

export async function setScheduledHostMaintenancePolicy(input = {}) {
  const principal = await requirePermission("maintenance.automatic_cleanup.approve");
  try {
    const data = await updateScheduledHostMaintenance({ actor: principal, input });
    revalidatePath("/settings/data-privacy");
    return { success: true, data };
  } catch (error) { return storageMaintenanceFailure(error, "Unable to update scheduled host maintenance."); }
}

export async function setManualImageRetentionPolicy(input = {}) {
  const principal = await requirePermission("maintenance.automatic_cleanup.approve");
  try {
    const data = await updateManualImageRetention({ actor: principal, input });
    revalidatePath("/settings/data-privacy");
    return { success: true, data };
  } catch (error) { return storageMaintenanceFailure(error, "Unable to update image retention policy."); }
}

export async function acknowledgeHostMaintenanceFailureAction(input = {}) {
  const principal = await requirePermission("maintenance.automatic_cleanup.approve");
  try {
    const data = await acknowledgeHostMaintenanceFailure({ actor: principal, input: {
      category: input.category, confirmation: String(input.confirmation || ""),
    } });
    revalidatePath("/settings/data-privacy");
    revalidatePath("/settings/data-privacy/cleanup");
    return { success: true, data };
  } catch (error) { return storageMaintenanceFailure(error, "Unable to acknowledge host maintenance failure."); }
}

export async function testBlueIrisConnection() {
  await requirePermission("system.manage_settings");
  try {
    const config = await getConfig();
    const result = await new BlueIrisClient(config.blueiris).testConnection();
    return { success: true, ...result };
  } catch (error) {
    return {
      success: false,
      error: error?.message || "Unable to connect to Blue Iris.",
    };
  }
}

export async function previewBlueIrisAlertMatch(input = {}) {
  await requirePermission("system.manage_settings");
  try {
    const config = await getConfig();
    const result = await new BlueIrisClient(config.blueiris).findNearestAlert({
      camera: input.camera,
      timestamp: input.timestamp,
      toleranceSeconds: input.toleranceSeconds,
    });
    return { success: true, ...result };
  } catch (error) {
    return {
      success: false,
      error: error?.message || "Unable to search Blue Iris alerts.",
    };
  }
}

export async function selectBlueIrisVehicleFrame(input = {}) {
  await requirePermission("system.manage_settings");
  try {
    const config = await getConfig();
    const pool = await getPool();
    const result = await new BlueIrisVehicleFrameService({
      client: new BlueIrisClient(config.blueiris),
      repository: new BlueIrisVehicleFrameRepository(pool),
      fileStorage,
    }).processNearestRead({
      camera: input.camera,
      cameraName: input.cameraName,
      timestamp: input.timestamp,
      toleranceSeconds: Math.min(
        30,
        Math.max(1, Number.parseInt(String(input.readToleranceSeconds ?? 3), 10) || 3)
      ),
    });
    revalidatePath("/live_feed");
    return { success: result.status === "ready", ...result };
  } catch (error) {
    console.error("Blue Iris vehicle-frame selection failed", error);
    const safeCodes = new Set([
      "CAMERA_REQUIRED",
      "CONNECTION_FAILED",
      "CREDENTIALS_REQUIRED",
      "FRAME_TOO_LARGE",
      "INVALID_TIMESTAMP",
      "LOGIN_FAILED",
      "RECORDING_UNAVAILABLE",
      "TIMEOUT",
      "VEHICLE_NOT_VISIBLE",
    ]);
    return {
      success: false,
      status: "failed",
      errorCode: error?.code || "FRAME_SELECTION_FAILED",
      message: safeCodes.has(error?.code)
        ? error.message
        : "Unable to select a Blue Iris vehicle frame.",
    };
  }
}

const ENTRY_OVERVIEW_HISTORY_PLATE_CAMERAS = Object.freeze([
  "Entry LPR 1",
  "Entry LPR 2",
]);
const ENTRY_OVERVIEW_SOURCE_CAMERA = "Entry Overview";
const ENTRY_OVERVIEW_SOURCE_SHORT_NAME = "Cam143";
const ENTRY_OVERVIEW_HISTORY_BATCH_SIZES = new Set([1, 5, 25, 250]);

function entryOverviewHistoryProfileData(profile) {
  return {
    id: Number(profile.id),
    profileKey: profile.profile_key,
    revision: Number(profile.revision || 1),
    profileKind: profile.profile_kind,
    sourceKind: profile.source_kind,
    overviewContext: profile.overview_context,
    sourceCameraName: profile.source_camera_name,
    sourceCameraShortName: profile.source_camera_short_name,
    plateCameraName: profile.plate_camera_name,
    expectedDeltaMs: Number(profile.expected_delta_ms),
    toleranceMs: Number(profile.tolerance_ms),
    algorithmRevision: profile.algorithm_revision,
    enabled: profile.enabled === true,
  };
}

function entryOverviewHistoryRunData(run) {
  if (!run) return null;
  const counts = run.counts || {};
  const count = (key) => Number(counts[key] || 0);
  const instant = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };
  return {
    id: Number(run.id),
    status: run.status,
    previewFingerprint: run.preview_fingerprint,
    startAt: instant(run.start_at),
    endAt: instant(run.end_at),
    batchSize: Number(run.batch_size || 25),
    oldestAt: instant(run.oldest_at),
    newestAt: instant(run.newest_at),
    confirmedAt: instant(run.confirmed_at),
    pausedAt: instant(run.paused_at),
    cancelledAt: instant(run.cancelled_at),
    completedAt: instant(run.completed_at),
    updatedAt: instant(run.updated_at),
    counts: {
      total: count("total"),
      eligible: count("eligible"),
      needsPreflight: count("needs_preflight"),
      nighttime: count("nighttime"),
      unverified: count("unverified"),
      liveBusy: count("live_busy"),
      preserved: count("preserved"),
      missingCandidates: count("missing_candidates"),
      upgradeCandidates: count("upgrade_candidates"),
      previewed: count("previewed"),
      previewableRemaining: count("previewable_remaining"),
      queued: count("queued"),
      processing: count("processing"),
      ready: count("ready"),
      failed: count("failed"),
      unavailable: count("unavailable"),
      superseded: count("superseded"),
      cancelled: count("cancelled"),
    },
  };
}

function entryOverviewHistoryRetryCandidateData(candidate) {
  if (!candidate) return null;
  const readTimestamp = candidate.read_timestamp ? new Date(candidate.read_timestamp) : null;
  return {
    jobId: Number(candidate.id),
    runId: Number(candidate.run_id),
    readId: Number(candidate.read_id),
    plateNumber: candidate.plate_number || null,
    plateCameraName: candidate.plate_camera_name,
    readTimestamp: readTimestamp && Number.isFinite(readTimestamp.getTime())
      ? readTimestamp.toISOString()
      : null,
    errorCode: candidate.error_code,
    attemptCount: Number(candidate.attempt_count || 0),
    operatorRetryCount: Number(candidate.operator_retry_count || 0),
    operatorRetryAt: candidate.operator_retry_at
      ? new Date(candidate.operator_retry_at).toISOString()
      : null,
    preservesExistingImage: Boolean(String(candidate.prior_image_path || "").trim()),
  };
}

function normalizedEntryOverviewHistoryRunId(value) {
  if (value == null || value === "") return null;
  const runId = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error("A valid Entry Overview history run is required.");
  }
  return runId;
}

function requiredEntryOverviewHistoryRunId(value) {
  const runId = normalizedEntryOverviewHistoryRunId(value);
  if (!runId) throw new Error("A valid Entry Overview history run is required.");
  return runId;
}

function requiredEntryOverviewHistoryJobId(value) {
  const jobId = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    throw new Error("A valid failed Entry Overview import is required.");
  }
  return jobId;
}

function normalizedEntryOverviewHistoryDate(value, label) {
  const date = new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is required.`);
  return date.toISOString();
}

export async function getBlueIrisVehicleFrameQueueStatus(input = {}) {
  await requirePermission("system.manage_settings");
  try {
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const runId = normalizedEntryOverviewHistoryRunId(input.entryOverviewHistoryRunId);
    const [status, entryOverviewHistoryRun, entryOverviewHistoryRetryCandidates] = await Promise.all([
      runtime.queue.getStatus(),
      runId
        ? runtime.repository.getEntryOverviewBackfillRun(runId, { jobLimit: 1 })
        : Promise.resolve(null),
      runtime.repository.listEntryOverviewBackfillRetryCandidates({ limit: 25 }),
    ]);
    return {
      success: true,
      data: {
        ...status,
        worker: runtime.worker.snapshot(),
        entryOverviewHistoryRun: entryOverviewHistoryRunData(entryOverviewHistoryRun),
        entryOverviewHistoryRetryCandidates: entryOverviewHistoryRetryCandidates
          .map(entryOverviewHistoryRetryCandidateData),
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to load Blue Iris vehicle-frame status.");
  }
}

export async function getVehicleOverviewSetup() {
  await requirePermission("system.manage_settings");
  try {
    const [runtime, directionSetup] = await Promise.all([
      getBlueIrisVehicleFrameRuntime(),
      (await getCaptureAssetService()).getDirectionSetup(null, {
        includeBackfill: false,
        includeCaptures: false,
        includeBlueIrisTriggerDirection: false,
      }),
    ]);
    const [
      profiles,
      status,
      entryRouteProfiles,
      entryFallback,
      entryHistoryProfiles,
      latestEntryHistoryRun,
      entryHistoryRetryCandidates,
    ] = await Promise.all([
      runtime.repository.listOverviewPairProfiles(),
      runtime.repository.getOverviewStatus(),
      runtime.repository.listEntryRouteProfiles(),
      runtime.repository.getEntryFallbackStatus(),
      runtime.repository.listEntryOverviewHistoryProfiles({ enabledOnly: true }),
      runtime.repository.getLatestEntryOverviewBackfillRun({ jobLimit: 1 }),
      runtime.repository.listEntryOverviewBackfillRetryCandidates({ limit: 25 }),
    ]);
    return {
      success: true,
      data: {
        profiles: profiles.map((profile) => ({
          id: Number(profile.id),
          sourceCameraName: profile.source_camera_name,
          sourceCameraShortName: profile.source_camera_short_name || "",
          plateCameraName: profile.plate_camera_name,
          directionLabel: profile.direction_label,
          sourceRole: profile.source_role,
          overviewContext: profile.overview_context || "street",
          expectedDeltaMs: Number(profile.expected_delta_ms),
          toleranceMs: Number(profile.tolerance_ms),
          priority: Number(profile.priority),
          enabled: profile.enabled === true,
          revision: Number(profile.revision || 1),
        })),
        plateCameras: directionSetup.profiles.map((profile) => ({
          cameraName: profile.cameraName,
          directions: [profile.frontDirectionLabel, profile.rearDirectionLabel].filter(Boolean),
        })),
        entryRouteProfiles: entryRouteProfiles.map((profile) => ({
          id: Number(profile.id),
          routeName: profile.route_name,
          targetCameraName: profile.target_camera_name,
          targetDirectionLabel: profile.target_direction_label,
          sourceDirectionLabel: profile.source_direction_label,
          sourceCameraNames: profile.source_camera_names || [],
          expectedDeltaMs: Number(profile.expected_delta_ms),
          toleranceMs: Number(profile.tolerance_ms),
          eventWindowMs: Number(profile.event_window_ms),
          minimumSourceCount: Number(profile.minimum_source_count),
          priority: Number(profile.priority),
          enabled: profile.enabled === true,
          revision: Number(profile.revision || 1),
        })),
        entryOverviewHistory: {
          sourceCameraName: "Entry Overview",
          sourceCameraShortName: "Cam143",
          plateCameraNames: ENTRY_OVERVIEW_HISTORY_PLATE_CAMERAS,
          toleranceMs: 3000,
          profiles: entryHistoryProfiles.map(entryOverviewHistoryProfileData),
          latestRun: entryOverviewHistoryRunData(latestEntryHistoryRun),
          retryCandidates: entryHistoryRetryCandidates.map(entryOverviewHistoryRetryCandidateData),
        },
        entryFallback,
        status,
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to load overview Vehicle View setup.");
  }
}

export async function saveVehicleEntryOverviewHistoryProfiles(input = {}) {
  await requirePermission("system.manage_settings");
  try {
    const requestedProfiles = new Map(
      (Array.isArray(input.profiles) ? input.profiles : []).map((profile) => [
        String(profile?.plateCameraName || "").trim(),
        profile,
      ])
    );
    const normalized = ENTRY_OVERVIEW_HISTORY_PLATE_CAMERAS.map((plateCameraName) => {
      const profile = requestedProfiles.get(plateCameraName);
      const expectedDeltaMs = Number.parseInt(String(profile?.expectedDeltaMs ?? ""), 10);
      if (!Number.isSafeInteger(expectedDeltaMs) || Math.abs(expectedDeltaMs) > 30_000) {
        throw new Error(`${plateCameraName} expected delta must be between -30000 and 30000 ms.`);
      }
      return { plateCameraName, expectedDeltaMs };
    });
    const runtime = await getBlueIrisVehicleFrameRuntime();
    for (const profile of normalized) {
      await runtime.repository.saveEntryOverviewHistoryProfile({
        ...profile,
        algorithmRevision: "entry-overview-history-v1",
      });
    }
    const profiles = await runtime.repository.listEntryOverviewHistoryProfiles({ enabledOnly: true });
    revalidatePath("/settings/vehicle-intelligence/vehicle-views");
    return {
      success: true,
      data: {
        sourceCameraName: "Entry Overview",
        sourceCameraShortName: "Cam143",
        plateCameraNames: ENTRY_OVERVIEW_HISTORY_PLATE_CAMERAS,
        toleranceMs: 3000,
        profiles: profiles.map(entryOverviewHistoryProfileData),
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to save Entry Overview history anchors.");
  }
}

export async function previewVehicleEntryOverviewHistory(input = {}) {
  await requirePermission("maintenance.manage");
  try {
    const startAt = normalizedEntryOverviewHistoryDate(input.startAt, "History start");
    const endAt = normalizedEntryOverviewHistoryDate(input.endAt, "History end");
    if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
      throw new Error("History end must be after history start.");
    }
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const run = await runtime.repository.previewEntryOverviewBackfillRun({
      startAt,
      endAt,
      plateCameraNames: ENTRY_OVERVIEW_HISTORY_PLATE_CAMERAS,
      batchSize: 25,
    });
    return { success: true, data: { run: entryOverviewHistoryRunData(run) } };
  } catch (error) {
    return visualSearchFailure(error, "Unable to preview Entry Overview history.");
  }
}

export async function confirmVehicleEntryOverviewHistory(input = {}) {
  await requirePermission("maintenance.manage");
  try {
    const runId = requiredEntryOverviewHistoryRunId(input.runId);
    const limit = Number.parseInt(String(input.limit), 10);
    if (!ENTRY_OVERVIEW_HISTORY_BATCH_SIZES.has(limit)) {
      throw new Error("Entry Overview history batches must contain 1, 5, 25, or 250 reads.");
    }
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const currentRun = await runtime.repository.getEntryOverviewBackfillRun(runId, { jobLimit: 1 });
    if (!currentRun) throw new Error("This Entry Overview history run was not found.");
    if (currentRun.status === "paused") {
      throw new Error("Resume Entry Overview history before queuing its next batch.");
    }
    if (Number(currentRun.counts?.queued || 0) + Number(currentRun.counts?.processing || 0) > 0) {
      throw new Error("Wait for the current Entry Overview history batch to finish before queuing another.");
    }
    const confirmation = await runtime.repository.confirmEntryOverviewBackfillRun({
      runId,
      previewFingerprint: input.previewFingerprint,
      limit,
    });
    if (confirmation.queued > 0) wakeBlueIrisVehicleFrameWorker();
    const run = await runtime.repository.getEntryOverviewBackfillRun(runId, { jobLimit: 1 });
    revalidatePath("/settings/vehicle-intelligence/vehicle-views");
    revalidatePath("/live_feed");
    return { success: true, data: { confirmation, run: entryOverviewHistoryRunData(run) } };
  } catch (error) {
    return visualSearchFailure(error, "Unable to confirm this Entry Overview history batch.");
  }
}

export async function setVehicleEntryOverviewHistoryPaused(input = {}) {
  await requirePermission("maintenance.manage");
  try {
    const runId = requiredEntryOverviewHistoryRunId(input.runId);
    const paused = input.paused === true;
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const updated = await runtime.repository.setEntryOverviewBackfillRunState(
      runId,
      paused ? "paused" : "running"
    );
    if (!updated) throw new Error("This Entry Overview history run is no longer active.");
    if (!paused) wakeBlueIrisVehicleFrameWorker();
    const run = await runtime.repository.getEntryOverviewBackfillRun(runId, { jobLimit: 1 });
    revalidatePath("/settings/vehicle-intelligence/vehicle-views");
    return { success: true, data: { run: entryOverviewHistoryRunData(run) } };
  } catch (error) {
    return visualSearchFailure(error, "Unable to update Entry Overview history processing.");
  }
}

export async function cancelVehicleEntryOverviewHistory(input = {}) {
  await requirePermission("maintenance.manage");
  try {
    const runId = requiredEntryOverviewHistoryRunId(input.runId);
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const cancellation = await runtime.repository.cancelEntryOverviewBackfillRun(runId);
    if (!cancellation) throw new Error("This Entry Overview history run is no longer active.");
    const run = await runtime.repository.getEntryOverviewBackfillRun(runId, { jobLimit: 1 });
    revalidatePath("/settings/vehicle-intelligence/vehicle-views");
    revalidatePath("/live_feed");
    return { success: true, data: { cancellation, run: entryOverviewHistoryRunData(run) } };
  } catch (error) {
    return visualSearchFailure(error, "Unable to cancel Entry Overview history processing.");
  }
}

export async function retryVehicleEntryOverviewHistoryImport(input = {}) {
  await requirePermission("maintenance.manage");
  try {
    const jobId = requiredEntryOverviewHistoryJobId(input.jobId);
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const retry = await runtime.repository.retryEntryOverviewBackfillJob(jobId);
    wakeBlueIrisVehicleFrameWorker();
    const [run, retryCandidates] = await Promise.all([
      runtime.repository.getEntryOverviewBackfillRun(retry.run_id, { jobLimit: 1 }),
      runtime.repository.listEntryOverviewBackfillRetryCandidates({ limit: 25 }),
    ]);
    revalidatePath("/settings/vehicle-intelligence/vehicle-views");
    revalidatePath("/live_feed");
    return {
      success: true,
      data: {
        retry: {
          jobId: Number(retry.id),
          runId: Number(retry.run_id),
          status: retry.status,
          operatorRetryCount: Number(retry.operator_retry_count || 0),
        },
        run: entryOverviewHistoryRunData(run),
        retryCandidates: retryCandidates.map(entryOverviewHistoryRetryCandidateData),
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to retry this failed Entry Overview import.");
  }
}

export async function saveVehicleOverviewPairProfile(input = {}) {
  const principal = await requirePermission("system.manage_settings");
  try {
    const sourceCameraName = String(input.sourceCameraName || "").trim();
    const sourceCameraShortName = String(input.sourceCameraShortName || "").trim();
    const plateCameraName = String(input.plateCameraName || "").trim();
    const directionLabel = String(input.directionLabel || "").trim();
    const sourceRole = String(input.sourceRole || "primary").toLowerCase();
    const overviewContext = String(input.overviewContext || "street").toLowerCase();
    const expectedDeltaMs = Number.parseInt(String(input.expectedDeltaMs ?? 0), 10);
    const toleranceMs = Number.parseInt(String(input.toleranceMs ?? 1500), 10);
    const priority = Number.parseInt(String(input.priority ?? 0), 10);
    if (!sourceCameraName || !plateCameraName || !directionLabel) {
      throw new Error("Source camera, plate camera, and direction are required.");
    }
    if (sourceCameraName.toLowerCase() === plateCameraName.toLowerCase()) {
      throw new Error("The Vehicle View source camera must be different from the plate camera.");
    }
    if (!["primary", "fallback"].includes(sourceRole)) {
      throw new Error("Overview source role must be primary or fallback.");
    }
    if (!["street", "entry"].includes(overviewContext)) {
      throw new Error("Overview use must be Street or Entry.");
    }
    const isEntryPlateCamera = ENTRY_OVERVIEW_HISTORY_PLATE_CAMERAS.includes(plateCameraName);
    if (overviewContext === "entry") {
      if (sourceRole !== "primary") {
        throw new Error("Entry Overview mappings must use the Primary overview role.");
      }
      if (!isEntryPlateCamera) {
        throw new Error("Entry Overview mappings are limited to Entry LPR 1 and Entry LPR 2.");
      }
      if (
        sourceCameraName.toLowerCase() !== ENTRY_OVERVIEW_SOURCE_CAMERA.toLowerCase()
        || sourceCameraShortName.toLowerCase() !== ENTRY_OVERVIEW_SOURCE_SHORT_NAME.toLowerCase()
      ) {
        throw new Error("Entry Overview must use the Blue Iris display name Entry Overview and short name Cam143.");
      }
    } else if (sourceRole === "primary" && isEntryPlateCamera) {
      throw new Error("Entry LPR primary Vehicle Views must use the Entry overview setting.");
    }
    if (!Number.isInteger(expectedDeltaMs) || expectedDeltaMs < -30_000 || expectedDeltaMs > 30_000) {
      throw new Error("Expected timing delta must be between -30000 and 30000 milliseconds.");
    }
    const maximumToleranceMs = sourceRole === "primary" ? 3_000 : 10_000;
    if (!Number.isInteger(toleranceMs) || toleranceMs < 250 || toleranceMs > maximumToleranceMs) {
      throw new Error(`Timing tolerance must be between 250 and ${maximumToleranceMs} milliseconds for this source role.`);
    }
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
      throw new Error("Overview priority must be between 0 and 100.");
    }
    const directionSetup = await (await getCaptureAssetService()).getDirectionSetup(plateCameraName);
    const camera = directionSetup.profiles.find((profile) => profile.cameraName === plateCameraName);
    if (!camera || ![camera.frontDirectionLabel, camera.rearDirectionLabel].includes(directionLabel)) {
      throw new Error("Select a configured direction from the chosen plate camera.");
    }
    const runtime = await getBlueIrisVehicleFrameRuntime();
    let persistedSourceCameraName = overviewContext === "entry"
      ? ENTRY_OVERVIEW_SOURCE_CAMERA
      : sourceCameraName;
    const persistedSourceCameraShortName = overviewContext === "entry"
      ? ENTRY_OVERVIEW_SOURCE_SHORT_NAME
      : sourceCameraShortName;
    if (sourceRole === "primary" && input.enabled !== false) {
      const existingProfiles = await runtime.repository.listPrimaryOverviewProfilesForRead({
        plateCameraName,
        directionLabel,
      });
      const conflictingProfile = existingProfiles.find((profile) => (
        String(profile.source_camera_name || "").trim().toLowerCase()
          !== sourceCameraName.toLowerCase()
      ));
      if (conflictingProfile) {
        throw new Error(
          `Disable the existing ${conflictingProfile.source_camera_name} primary profile for this camera and direction first.`
        );
      }
      const sameProfile = existingProfiles.find((profile) => (
        String(profile.source_camera_name || "").trim().toLowerCase()
          === sourceCameraName.toLowerCase()
      ));
      if (sameProfile) persistedSourceCameraName = sameProfile.source_camera_name;
    }
    const saved = await runtime.repository.saveOverviewPairProfile({
      sourceCameraName: persistedSourceCameraName,
      sourceCameraShortName: persistedSourceCameraShortName,
      plateCameraName,
      directionLabel,
      sourceRole,
      overviewContext,
      expectedDeltaMs,
      toleranceMs,
      priority,
      enabled: input.enabled !== false,
    }, principal);
    runtime.worker.wake();
    revalidatePath("/settings/vehicle-intelligence");
    return { success: true, data: { id: Number(saved.id) } };
  } catch (error) {
    return visualSearchFailure(error, "Unable to save this overview association profile.");
  }
}

export async function deleteVehicleOverviewPairProfile(profileId) {
  const principal = await requirePermission("system.manage_settings");
  try {
    const normalizedId = Number.parseInt(String(profileId), 10);
    if (!Number.isSafeInteger(normalizedId) || normalizedId <= 0) {
      throw new Error("A valid overview association profile is required.");
    }
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const deleted = await runtime.repository.deleteOverviewPairProfile(normalizedId, principal);
    if (!deleted) {
      throw new Error("This overview profile is already in use and cannot be deleted; disable it instead.");
    }
    revalidatePath("/settings/vehicle-intelligence");
    return { success: true };
  } catch (error) {
    return visualSearchFailure(error, "Unable to delete this overview association profile.");
  }
}

export async function setVehicleOverviewPairSharingMode(mode) {
  const principal = await requirePermission("system.manage_settings");
  try {
    const normalizedMode = String(mode || "").trim().toLowerCase();
    if (!["off", "shadow", "active"].includes(normalizedMode)) {
      throw new Error("Select Off, Shadow, or Active for Street pair sharing.");
    }
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const saved = await runtime.repository.setStreetPairSharingMode(normalizedMode, principal);
    if (normalizedMode !== "off") runtime.worker.wake();
    revalidatePath("/settings/vehicle-intelligence");
    revalidatePath("/settings/vehicle-intelligence/vehicle-views");
    return {
      success: true,
      data: {
        mode: saved.mode,
        observationStartedAt: saved.observation_started_at,
        updatedAt: saved.updated_at,
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to update Street pair sharing.");
  }
}

export async function setVehicleEntryFallbackMode(input = {}) {
  const principal = await requirePermission("system.manage_settings");
  try {
    const mode = String(input.mode || "").trim().toLowerCase();
    if (!["off", "shadow", "active"].includes(mode)) {
      throw new Error("Select Off, Shadow, or Active for Entry LPR fallback.");
    }
    const overviewPayloadMode = String(input.overviewPayloadMode || "shadow").trim().toLowerCase();
    if (!["off", "shadow", "active"].includes(overviewPayloadMode)) {
      throw new Error("Select Off, Shadow, or Active for the Entry Overview payload.");
    }
    const observationStartedAt = input.observationStartedAt
      ? new Date(input.observationStartedAt)
      : null;
    if (observationStartedAt && Number.isNaN(observationStartedAt.getTime())) {
      throw new Error("Enter a valid observation start time.");
    }
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const saved = await runtime.repository.setEntryFallbackMode(mode, {
      overviewPayloadMode,
      observationStartedAt: observationStartedAt?.toISOString() || null,
      actor: principal,
    });
    if (mode !== "off") runtime.worker.wake();
    revalidatePath("/settings/vehicle-intelligence");
    revalidatePath("/settings/vehicle-intelligence/vehicle-views");
    return {
      success: true,
      data: {
        mode: saved.mode,
        overviewPayloadMode: saved.overview_payload_mode || "shadow",
        observationStartedAt: saved.observation_started_at,
        updatedAt: saved.updated_at,
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to update Entry LPR fallback.");
  }
}

export async function saveVehicleEntryRouteProfile(input = {}) {
  const principal = await requirePermission("system.manage_settings");
  try {
    const routeName = String(input.routeName || "").trim();
    const targetCameraName = String(input.targetCameraName || "").trim();
    const targetDirectionLabel = String(input.targetDirectionLabel || "").trim();
    const sourceDirectionLabel = String(input.sourceDirectionLabel || "").trim();
    const sourceCameraNames = [...new Set(
      (Array.isArray(input.sourceCameraNames) ? input.sourceCameraNames : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )];
    const expectedDeltaMs = Number.parseInt(String(input.expectedDeltaMs ?? 0), 10);
    const toleranceMs = Number.parseInt(String(input.toleranceMs ?? 3000), 10);
    const eventWindowMs = Number.parseInt(String(input.eventWindowMs ?? 3000), 10);
    const priority = Number.parseInt(String(input.priority ?? 0), 10);
    if (!routeName || !targetCameraName || !targetDirectionLabel || !sourceDirectionLabel) {
      throw new Error("Route name, target camera, target direction, and Entry direction are required.");
    }
    if (sourceCameraNames.length !== 2) {
      throw new Error("Select exactly two different Entry LPR cameras for corroboration.");
    }
    if (sourceCameraNames.some((camera) => camera.toLowerCase() === targetCameraName.toLowerCase())) {
      throw new Error("An Entry source camera must be different from the Street target camera.");
    }
    if (!Number.isInteger(expectedDeltaMs) || expectedDeltaMs < -30_000 || expectedDeltaMs > 30_000) {
      throw new Error("Expected timing delta must be between -30000 and 30000 milliseconds.");
    }
    if (!Number.isInteger(toleranceMs) || toleranceMs < 250 || toleranceMs > 15_000) {
      throw new Error("Route timing tolerance must be between 250 and 15000 milliseconds.");
    }
    if (!Number.isInteger(eventWindowMs) || eventWindowMs < 250 || eventWindowMs > 5_000) {
      throw new Error("Entry camera event window must be between 250 and 5000 milliseconds.");
    }
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
      throw new Error("Route priority must be between 0 and 100.");
    }
    const directionSetup = await (await getCaptureAssetService()).getDirectionSetup();
    const profiles = new Map(directionSetup.profiles.map((profile) => [profile.cameraName, profile]));
    const targetProfile = profiles.get(targetCameraName);
    if (!targetProfile || ![targetProfile.frontDirectionLabel, targetProfile.rearDirectionLabel].includes(targetDirectionLabel)) {
      throw new Error("Select a configured direction from the chosen Street target camera.");
    }
    for (const cameraName of sourceCameraNames) {
      const sourceProfile = profiles.get(cameraName);
      if (!sourceProfile || ![sourceProfile.frontDirectionLabel, sourceProfile.rearDirectionLabel].includes(sourceDirectionLabel)) {
        throw new Error(`The ${cameraName} camera is not configured for ${sourceDirectionLabel}.`);
      }
    }
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const saved = await runtime.repository.saveEntryRouteProfile({
      routeName,
      targetCameraName,
      targetDirectionLabel,
      sourceDirectionLabel,
      sourceCameraNames,
      expectedDeltaMs,
      toleranceMs,
      eventWindowMs,
      minimumSourceCount: 2,
      priority,
      enabled: input.enabled !== false,
    }, principal);
    runtime.worker.wake();
    revalidatePath("/settings/vehicle-intelligence/vehicle-views");
    return { success: true, data: { id: Number(saved.id), revision: Number(saved.revision) } };
  } catch (error) {
    return visualSearchFailure(error, "Unable to save this Entry LPR route.");
  }
}

export async function deleteVehicleEntryRouteProfile(profileId) {
  const principal = await requirePermission("system.manage_settings");
  try {
    const normalizedId = Number.parseInt(String(profileId), 10);
    if (!Number.isSafeInteger(normalizedId) || normalizedId <= 0) {
      throw new Error("A valid Entry LPR route profile is required.");
    }
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const deleted = await runtime.repository.deleteEntryRouteProfile(normalizedId, principal);
    if (!deleted) {
      throw new Error("This route already has audit decisions and cannot be deleted; disable it instead.");
    }
    revalidatePath("/settings/vehicle-intelligence/vehicle-views");
    return { success: true };
  } catch (error) {
    return visualSearchFailure(error, "Unable to delete this Entry LPR route.");
  }
}

export async function retryBlueIrisVehicleFrameForRead(readId) {
  await requirePermission("plate.review");
  try {
    const normalizedReadId = Number.parseInt(String(readId), 10);
    if (!Number.isSafeInteger(normalizedReadId) || normalizedReadId <= 0) {
      return { success: false, error: "A valid plate read is required." };
    }
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const queued = await runtime.repository.retryRead(normalizedReadId);
    if (!queued) {
      return {
        success: false,
        error: "This vehicle view is no longer eligible for a retry. Refresh the read and try again.",
      };
    }
    wakeBlueIrisVehicleFrameWorker();
    revalidatePath("/live_feed");
    return {
      success: true,
      data: {
        readId: normalizedReadId,
        status: queued.vehicle_image_status,
        queueKind: queued.vehicle_image_queue_kind,
        attemptCount: Number(queued.vehicle_image_attempt_count || 0),
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to retry this Blue Iris vehicle view.");
  }
}

export async function queueBlueIrisVehicleFrameHistory(input = {}) {
  await requirePermission("maintenance.manage");
  try {
    const runtime = await getBlueIrisVehicleFrameRuntime();
    await runtime.queue.setHistoricalPaused(true);
    const queued = await runtime.queue.queueHistorical({
      cameraName: input.cameraName || null,
      startDate: input.startDate || null,
      endDate: input.endDate || null,
      replaceExisting: input.replaceExisting === true,
    });
    revalidatePath("/settings/vehicle-intelligence");
    return {
      success: true,
      data: {
        ...queued,
        status: {
          ...await runtime.queue.getStatus(),
          worker: runtime.worker.snapshot(),
        },
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to queue historical Blue Iris vehicle frames.");
  }
}

export async function cancelBlueIrisVehicleFrameHistory(input = {}) {
  await requirePermission("maintenance.manage");
  try {
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const cancelled = await runtime.queue.cancelHistorical({
      cameraName: input.cameraName || null,
      startDate: input.startDate || null,
      endDate: input.endDate || null,
    });
    revalidatePath("/settings/vehicle-intelligence");
    return {
      success: true,
      data: {
        ...cancelled,
        status: {
          ...await runtime.queue.getStatus(),
          worker: runtime.worker.snapshot(),
        },
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to cancel historical Blue Iris vehicle frames.");
  }
}

export async function setBlueIrisVehicleFrameHistoryPaused(paused) {
  await requirePermission("maintenance.manage");
  try {
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const control = await runtime.queue.setHistoricalPaused(paused === true);
    if (paused !== true) wakeBlueIrisVehicleFrameWorker();
    revalidatePath("/settings/vehicle-intelligence");
    return {
      success: true,
      data: {
        control,
        status: {
          ...await runtime.queue.getStatus(),
          worker: runtime.worker.snapshot(),
        },
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to update Blue Iris historical frame processing.");
  }
}

export async function runBlueIrisVehicleFrameBatch() {
  await requirePermission("maintenance.manage");
  try {
    const runtime = await getBlueIrisVehicleFrameRuntime();
    const batch = await runtime.queue.processBatch({ limit: 1 });
    revalidatePath("/settings/vehicle-intelligence");
    revalidatePath("/live_feed");
    return {
      success: true,
      data: {
        batch,
        status: {
          ...await runtime.queue.getStatus(),
          worker: runtime.worker.snapshot(),
        },
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to process a Blue Iris vehicle frame.");
  }
}

export async function recoverIncompleteBlueIrisOverviewReads(input = {}) {
  await requirePermission("maintenance.manage");
  try {
    const runtime = await getBlueIrisVehicleFrameRuntime();
    if (input.previewOnly === true) {
      const preview = await runtime.repository.previewIncompleteOverviewReads({
        startAt: input.startAt ?? null,
        sinceHours: input.sinceHours ?? 48,
      });
      return { success: true, data: { preview } };
    }
    const recovery = await runtime.repository.recoverIncompleteOverviewReads({
      startAt: input.startAt ?? null,
      sinceHours: input.sinceHours ?? 48,
    });
    if (recovery.queued > 0) wakeBlueIrisVehicleFrameWorker();
    revalidatePath("/settings/vehicle-intelligence");
    revalidatePath("/live_feed");
    return {
      success: true,
      data: {
        ...recovery,
        status: {
          ...await runtime.queue.getStatus(),
          worker: runtime.worker.snapshot(),
        },
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to recover incomplete overview Vehicle Views.");
  }
}

export async function recoverBlueIrisCompositeTriggerReads(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getBlueIrisVehicleFrameRuntime();
    if (input.previewOnly === true) {
      const preview = await runtime.repository.previewBlueIrisCompositeTriggerRecovery({
        startAt: input.startAt,
        endAt: input.endAt ?? null,
      });
      return { success: true, data: { preview } };
    }
    const recovery = await runtime.repository.recoverBlueIrisCompositeTriggers({
      startAt: input.startAt,
      endAt: input.endAt,
      readIds: input.readIds,
      actor: principal,
    });
    if (recovery.queued > 0) wakeBlueIrisVehicleFrameWorker();
    revalidatePath("/settings/vehicle-intelligence");
    revalidatePath("/settings/vehicle-intelligence/vehicle-views");
    revalidatePath("/live_feed");
    return {
      success: true,
      data: {
        ...recovery,
        status: {
          ...await runtime.queue.getStatus(),
          worker: runtime.worker.snapshot(),
        },
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to repair Blue Iris composite trigger Vehicle Views.");
  }
}

export async function getPlateViewSettings() {
  await requirePermission("plate.read");
  const config = await getConfig();
  return {
    plateMatching: normalizePlateMatchingSettings(config.plateMatching),
    blueiris: {
      host: config.blueiris?.host || "",
    },
  };
}

export async function updateSettings(formData) {
  await requirePermission("system.manage_settings");
  try {
    const currentConfig = await getConfig();

    const newConfig = { ...currentConfig };

    const updateIfExists = (key) => formData.get(key) !== null;

    //isolate sections so we don't erase other stuff
    if (updateIfExists("maxRecords") || updateIfExists("ignoreNonPlate")) {
      newConfig.general = {
        ...currentConfig.general,
        maxRecords: formData.get("maxRecords")
          ? parseInt(formData.get("maxRecords"))
          : currentConfig.general.maxRecords,
        retention: formData.get("retention")
          ? parseInt(formData.get("retention"))
          : currentConfig.general.retention,
        ignoreNonPlate: formData.get("ignoreNonPlate") === "true",
        timeFormat: formData.get("timeFormat")
          ? parseInt(formData.get("timeFormat"))
          : currentConfig.general.timeFormat,
      };
    }

    if (
      updateIfExists("dbHost") ||
      updateIfExists("dbName") ||
      updateIfExists("dbUser") ||
      updateIfExists("dbPassword")
    ) {
      newConfig.database = {
        ...currentConfig.database,
        host: formData.get("dbHost") ?? currentConfig.database.host,
        name: formData.get("dbName") ?? currentConfig.database.name,
        user: formData.get("dbUser") ?? currentConfig.database.user,
        password: resolveStoredSecretUpdate({
          currentValue: currentConfig.database.password,
          replacement: formData.get("dbPassword"),
        }),
      };
    }

    if (updateIfExists("pushoverEnabled")) {
      newConfig.notifications = {
        ...currentConfig.notifications,
        pushover: {
          ...currentConfig.notifications?.pushover,
          enabled: formData.get("pushoverEnabled") === "true",
          app_token: resolveStoredSecretUpdate({
            currentValue: currentConfig.notifications?.pushover?.app_token,
            replacement: formData.get("pushoverAppToken"),
            clear: formData.get("clearPushoverAppToken"),
          }),
          user_key: resolveStoredSecretUpdate({
            currentValue: currentConfig.notifications?.pushover?.user_key,
            replacement: formData.get("pushoverUserKey"),
            clear: formData.get("clearPushoverUserKey"),
          }),
          title:
            formData.get("pushoverTitle") ??
            currentConfig.notifications?.pushover?.title,
          priority: formData.get("pushoverPriority")
            ? parseInt(formData.get("pushoverPriority"))
            : currentConfig.notifications?.pushover?.priority,
          sound:
            formData.get("pushoverSound") ??
            currentConfig.notifications?.pushover?.sound,
        },
      };
    }

    if (updateIfExists("emailEnabled")) {
      const smtpPort = Number(formData.get("emailPort") || currentConfig.notifications?.email?.port || 587);
      if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
        throw new Error("SMTP port must be between 1 and 65535");
      }
      newConfig.notifications = {
        ...newConfig.notifications,
        email: {
          ...currentConfig.notifications?.email,
          enabled: formData.get("emailEnabled") === "true",
          host: String(formData.get("emailHost") ?? currentConfig.notifications?.email?.host ?? "").trim(),
          port: smtpPort,
          secure: formData.get("emailSecure") === "true",
          verify_tls: formData.get("emailVerifyTls") !== "false",
          username: String(formData.get("emailUsername") ?? currentConfig.notifications?.email?.username ?? "").trim(),
          password: resolveStoredSecretUpdate({
            currentValue: currentConfig.notifications?.email?.password,
            replacement: formData.get("emailPassword"),
            clear: formData.get("clearEmailPassword"),
          }),
          from_address: String(formData.get("emailFromAddress") ?? currentConfig.notifications?.email?.from_address ?? "").trim(),
          from_name: String(formData.get("emailFromName") ?? currentConfig.notifications?.email?.from_name ?? "").trim(),
        },
      };
    }

    if (updateIfExists("webhookEnabled")) {
      const timeoutSeconds = Number(formData.get("webhookTimeoutSeconds") || currentConfig.notifications?.webhook?.timeout_seconds || 10);
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 2 || timeoutSeconds > 30) {
        throw new Error("Webhook timeout must be between 2 and 30 seconds");
      }
      newConfig.notifications = {
        ...newConfig.notifications,
        webhook: {
          ...currentConfig.notifications?.webhook,
          enabled: formData.get("webhookEnabled") === "true",
          signing_secret: resolveStoredSecretUpdate({
            currentValue: currentConfig.notifications?.webhook?.signing_secret,
            replacement: formData.get("webhookSigningSecret"),
            clear: formData.get("clearWebhookSigningSecret"),
          }),
          timeout_seconds: timeoutSeconds,
          allow_http: formData.get("webhookAllowHttp") === "true",
          allow_private_networks: formData.get("webhookAllowPrivateNetworks") === "true",
        },
      };
    }

    if (updateIfExists("haEnabled") || updateIfExists("haWhitelist")) {
      newConfig.homeassistant = {
        ...currentConfig.homeassistant,
        enabled: formData.get("haEnabled") === "true",
        whitelist: formData.get("haWhitelist")
          ? JSON.parse(formData.get("haWhitelist"))
          : currentConfig.homeassistant?.whitelist || [],
      };
    }
    if (
      updateIfExists("bihost") ||
      updateIfExists("biUsername") ||
      updateIfExists("biPassword") ||
      updateIfExists("biTimeoutSeconds") ||
      updateIfExists("biTimelineExportProfile") ||
      updateIfExists("biTimelineExportMinWidth") ||
      updateIfExists("biTimelineExportMinHeight")
    ) {
      const candidateBlueIris = {
        ...currentConfig.blueiris,
        host: formData.get("bihost") ?? currentConfig.blueiris?.host,
        username: String(
          formData.get("biUsername") ?? currentConfig.blueiris?.username ?? ""
        ).trim(),
        password: resolveStoredSecretUpdate({
          currentValue: currentConfig.blueiris?.password,
          replacement: formData.get("biPassword"),
          clear: formData.get("clearBiPassword"),
        }),
        timeout_seconds: Number(
          formData.get("biTimeoutSeconds") ??
            currentConfig.blueiris?.timeout_seconds ??
            10
        ),
        timeline_export_profile: Number(
          formData.get("biTimelineExportProfile")
            ?? currentConfig.blueiris?.timeline_export_profile
            ?? 0
        ),
        timeline_export_min_width: Number(
          formData.get("biTimelineExportMinWidth")
            ?? currentConfig.blueiris?.timeline_export_min_width
            ?? 1920
        ),
        timeline_export_min_height: Number(
          formData.get("biTimelineExportMinHeight")
            ?? currentConfig.blueiris?.timeline_export_min_height
            ?? 1080
        ),
      };
      normalizeBlueIrisSettings(candidateBlueIris);
      if (!Number.isInteger(candidateBlueIris.timeline_export_profile)
        || candidateBlueIris.timeline_export_profile < 0
        || candidateBlueIris.timeline_export_profile > 3) {
        throw new Error("Blue Iris timeline export profile must be between 0 and 3.");
      }
      if (!Number.isInteger(candidateBlueIris.timeline_export_min_width)
        || candidateBlueIris.timeline_export_min_width < 1920
        || candidateBlueIris.timeline_export_min_width > 7680
        || !Number.isInteger(candidateBlueIris.timeline_export_min_height)
        || candidateBlueIris.timeline_export_min_height < 1080
        || candidateBlueIris.timeline_export_min_height > 4320) {
        throw new Error("Blue Iris minimum timeline export resolution is invalid.");
      }
      newConfig.blueiris = {
        ...candidateBlueIris,
      };
    }
    if (updateIfExists("plateMatching")) {
      newConfig.plateMatching = normalizePlateMatchingSettings(
        JSON.parse(formData.get("plateMatching"))
      );
    }
    const result = await saveConfig(newConfig);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    revalidatePath("/settings");
    revalidatePath("/settings/integrations");
    revalidatePath("/settings/integrations/pushover");
    revalidatePath("/settings/integrations/email");
    revalidatePath("/settings/integrations/webhook");
    revalidatePath("/settings/blue-iris");
    return { success: true };
  } catch (error) {
    console.error("Error updating settings:", error);
    return { success: false, error: error.message };
  }
}

export async function updatePassword(formData) {
  const principal = await requireAuthenticatedSession();
  const currentPassword = formData.get("currentPassword");
  const newPassword = formData.get("newPassword");
  const confirmPassword = formData.get("confirmPassword");

  if (!currentPassword || !newPassword || !confirmPassword) {
    return { error: "All password fields are required." };
  }

  if (newPassword !== confirmPassword) {
    return { error: "New password and confirmation do not match." };
  }

  if (newPassword.length < 8) {
    return { error: "New password must be at least 8 characters long." };
  }

  try {
    if (principal.authMode === "named") {
      await getIdentityService().changeOwnPassword({
        actor: principal,
        currentPassword,
        newPassword,
      });
    } else {
      const isCurrentPasswordValid = await verifyPassword(currentPassword);
      if (!isCurrentPasswordValid) {
        return { error: "Incorrect current password." };
      }

      const newHashedPassword = await hashPasswordBcrypt(newPassword);
      const config = await getAuthConfig();
      if (!config) {
        return { error: "Authentication configuration could not be loaded." };
      }

      config.password = newHashedPassword;
      config.sessions = {};
      await updateAuthConfig(config);
    }
  } catch {
    console.error("Password update failed");
    return { error: "An error occurred while changing password." };
  }

  const cookieStore = await cookies();
  clearSessionCookie(cookieStore);
  redirect("/login");
}

export async function regenerateApiKey() {
  await requirePermission("system.manage_settings");
  try {
    const config = await getAuthConfig();
    const newApiKey = crypto.randomBytes(32).toString("hex");

    await updateAuthConfig({
      ...config,
      apiKey: newApiKey,
    });

    revalidatePath("/settings");
    return { success: true, apiKey: newApiKey };
  } catch {
    console.error("API key regeneration failed");
    return { success: false, error: "Unable to regenerate API key." };
  }
}

export async function getCameraNames() {
  await requirePermission("plate.read");
  try {
    const cameraNames = await getDistinctCameraNames();
    return {
      success: true,
      data: cameraNames,
    };
  } catch (error) {
    console.error("Error getting camera names:", error);
    return {
      success: false,
      error: "Failed to fetch camera names",
    };
  }
}

export async function getDirectionLabels() {
  await requirePermission("plate.read");
  try {
    return { success: true, data: await getDistinctDirectionLabels() };
  } catch (error) {
    console.error("Error getting direction labels:", error);
    return { success: false, error: "Failed to fetch direction labels", data: [] };
  }
}

export async function correctPlateRead(formData) {
  const principal = await requirePermission("plate.review");
  try {
    const readId = formData.get("readId");
    const oldPlateNumber = formData.get("oldPlateNumber");
    const newPlateNumber = formData.get("newPlateNumber");
    const correctAll = formData.get("correctAll") === "true";
    const rememberAlias = formData.get("rememberAlias") === "true";
    const replaceAlias = formData.get("replaceAlias") === "true";
    const cameraName =
      formData.get("aliasScope") === "camera"
        ? formData.get("cameraName")
        : null;
    const reason = formData.get("reason");
    const notes = formData.get("notes");
    const repository = getPlateReviewRepository();
    const normalizedOldPlate = String(oldPlateNumber || "").trim().toUpperCase();
    const normalizedNewPlate = String(newPlateNumber || "").trim().toUpperCase();
    const plateChanged = normalizedOldPlate !== normalizedNewPlate;

    if (correctAll && plateChanged && !hasPermission(principal, "plate.review.batch")) {
      return { success: false, error: "Administrator permission is required for batch correction." };
    }
    if (rememberAlias && !hasPermission(principal, "plate.alias.manage")) {
      return { success: false, error: "Administrator permission is required to create a recurring alias." };
    }
    if (!plateChanged && !rememberAlias) {
      return { success: false, error: "The corrected plate is already the effective plate." };
    }

    const aliasSourcePlate = formData.get("aliasSourcePlate") || oldPlateNumber;
    const existingAlias = rememberAlias
      ? await repository.getEnabledAlias({ sourcePlate: aliasSourcePlate, cameraName })
      : null;
    if (
      existingAlias &&
      existingAlias.target_plate !== normalizedNewPlate &&
      !replaceAlias
    ) {
      return {
        success: false,
        code: "ALIAS_REPLACE_CONFIRMATION_REQUIRED",
        error: "Confirm whether to replace the existing recurring alias.",
        aliasConflict: {
          id: existingAlias.id,
          sourcePlate: existingAlias.source_plate,
          targetPlate: existingAlias.target_plate,
          cameraName: existingAlias.camera_name || null,
          replacementTargetPlate: normalizedNewPlate,
        },
      };
    }

    const data = !plateChanged
      ? {
          id: Number(readId),
          effectivePlate: normalizedNewPlate,
          aliasOnly: true,
        }
      : correctAll
        ? await repository.batchCorrect({
          sourcePlate: oldPlateNumber,
          targetPlate: newPlateNumber,
          cameraName: formData.get("batchCameraOnly") === "true"
            ? formData.get("cameraName")
            : null,
          unreviewedOnly: formData.get("unreviewedOnly") === "true",
          reason,
          notes,
          actor: principal,
          })
        : await repository.reviewRead({
          readId,
          action: "correct",
          newPlate: newPlateNumber,
          reason,
          notes,
          actor: principal,
          });

    let alias = null;
    let replacedAlias = null;
    let warning = null;
    if (rememberAlias) {
      try {
        const aliasResult = await repository.createOrReplaceAlias({
          sourcePlate: aliasSourcePlate,
          targetPlate: newPlateNumber,
          cameraName,
          reason,
          actor: principal,
          replaceExisting: replaceAlias,
        });
        alias = aliasResult.alias;
        replacedAlias = aliasResult.replacedAlias;
      } catch (error) {
        warning = error?.message || "The read was corrected, but the recurring alias could not be created.";
      }
    }

    revalidatePath("/live_feed");
    revalidatePath("/database");
    return { success: true, data, alias, replacedAlias, warning };
  } catch (error) {
    return plateReviewActionFailure(error, "Failed to correct the plate read.");
  }
}

export async function previewPlateCorrection(formData) {
  const principal = await requirePermission("plate.review.batch");
  try {
    return {
      success: true,
      data: await getPlateReviewRepository().previewBatch({
        sourcePlate: formData.get("oldPlateNumber"),
        cameraName:
          formData.get("batchCameraOnly") === "true"
            ? formData.get("cameraName")
            : null,
        unreviewedOnly: formData.get("unreviewedOnly") === "true",
        actor: principal,
      }),
    };
  } catch (error) {
    return plateReviewActionFailure(error, "Unable to preview the batch correction.");
  }
}

export async function getPlateReviewHistory(readId) {
  await requirePermission("plate.read");
  try {
    return {
      success: true,
      data: await getPlateReviewRepository().getHistory(readId),
    };
  } catch (error) {
    return plateReviewActionFailure(error, "Unable to load plate review history.");
  }
}

export async function reversePlateReview(formData) {
  const principal = await requirePermission("plate.review.batch");
  try {
    const disableAliasId = formData.get("disableAliasId");
    if (disableAliasId && !hasPermission(principal, "plate.alias.manage")) {
      return {
        success: false,
        error: "Administrator permission is required to disable a recurring alias.",
      };
    }
    const data = await getPlateReviewRepository().reverseLatestReview({
      readId: formData.get("readId"),
      reason: formData.get("reason"),
      actor: principal,
      disableAliasId: disableAliasId || null,
    });
    revalidatePath("/live_feed");
    revalidatePath("/database");
    revalidatePath("/settings");
    return { success: true, data };
  } catch (error) {
    return plateReviewActionFailure(error, "Unable to reverse the plate review.");
  }
}

export async function listPlateAliases() {
  await requirePermission("plate.alias.manage");
  try {
    return { success: true, data: await getPlateReviewRepository().listAliases() };
  } catch (error) {
    return plateReviewActionFailure(error, "Unable to load recurring plate aliases.");
  }
}

export async function createPlateAlias(formData) {
  const principal = await requirePermission("plate.alias.manage");
  try {
    const data = await getPlateReviewRepository().createAlias({
      sourcePlate: formData.get("sourcePlate"),
      targetPlate: formData.get("targetPlate"),
      cameraName: formData.get("cameraName"),
      reason: formData.get("reason"),
      actor: principal,
    });
    revalidatePath("/settings");
    return { success: true, data };
  } catch (error) {
    return plateReviewActionFailure(error, "Unable to create the recurring alias.");
  }
}

export async function disablePlateAlias(formData) {
  const principal = await requirePermission("plate.alias.manage");
  try {
    const data = await getPlateReviewRepository().disableAlias({
      aliasId: formData.get("aliasId"),
      reason: formData.get("reason") || "disabled_by_administrator",
      actor: principal,
    });
    revalidatePath("/settings");
    return { success: true, data };
  } catch (error) {
    return plateReviewActionFailure(error, "Unable to disable the recurring alias.");
  }
}

export async function getTimeFormat() {
  await requirePermission("plate.read");
  const config = await getConfig();
  return config.general.timeFormat;
}

export async function toggleIgnorePlate(formData) {
  await requirePermission("plate.review");
  try {
    const plateNumber = formData.get("plateNumber");
    const ignore = formData.get("ignore") === "true";

    const result = await togglePlateIgnore(plateNumber, ignore);
    return { success: true, data: result };
  } catch (error) {
    console.error("Failed to toggle plate ignore:", error);
    return { success: false, error: "Failed to toggle plate ignore" };
  }
}

export async function revalidatePlatesPage() {
  await requirePermission("plate.read");
  try {
    revalidatePath("/live_feed");
  } catch (error) {
    console.error("🔴 Revalidation failed:", error);
    throw error;
  }
}

export async function fetchPlateImagePreviews(
  plateNumber,
  timeFrame,
  cameraNames = [],
  rangeStart,
  rangeEnd
) {
  await requirePermission("plate.read");
  const fallbackWindow = getDashboardTimeWindow(timeFrame);
  const requestedStart = new Date(rangeStart || "");
  const requestedEnd = new Date(rangeEnd || "");
  const hasValidRequestedWindow =
    !Number.isNaN(requestedStart.getTime()) &&
    !Number.isNaN(requestedEnd.getTime()) &&
    requestedStart < requestedEnd;
  const startDate = hasValidRequestedWindow
    ? requestedStart
    : fallbackWindow.startDate;
  const endDate = hasValidRequestedWindow ? requestedEnd : fallbackWindow.endDate;
  return await getPlateImagePreviews(
    plateNumber,
    startDate,
    endDate,
    normalizeDashboardCameraNames(cameraNames)
  );
}

const systemLogsLogger = createComponentLogger("system-logs");
const ingressReceiptsLogger = createComponentLogger("ingress-receipts");
const readPipelineLogger = createComponentLogger("read-pipeline-timeline");
const loggingRetentionLogger = createComponentLogger("logging-retention");

function operationalLogOrder(name) {
  if (name === "app.log") return Number.MAX_SAFE_INTEGER;
  const match = name.match(/^app(\d+)\.log$/);
  return match ? -Number(match[1]) : 0;
}

async function readOperationalLogFile({ includeRotated = false } = {}) {
  const activeMaximumBytes = Number.parseInt(
    process.env.ALPR_OPERATIONAL_LOG_FILE_MAX_BYTES || "5242880",
    10
  );
  const maximumFiles = Number.parseInt(
    process.env.ALPR_OPERATIONAL_LOG_MAX_FILES || "20",
    10
  );
  const logDirectory = path.resolve(
    process.env.ALPR_LOG_DIR || path.join(process.cwd(), "logs")
  );
  try {
    const names = await fs.readdir(logDirectory);
    const retainedNames = names
      .filter((name) => name === "app.log" || /^app\d+\.log$/.test(name))
      .sort((left, right) => operationalLogOrder(left) - operationalLogOrder(right))
      .slice(-Math.max(1, maximumFiles));
    const retainedFiles = (await Promise.all(
      retainedNames.map(async (name) => {
        const fullPath = path.join(logDirectory, name);
        try {
          const [stats, content] = await Promise.all([
            fs.stat(fullPath),
            includeRotated || name === "app.log" ? fs.readFile(fullPath, "utf8") : "",
          ]);
          return { name, stats, content };
        } catch (error) {
          if (error?.code === "ENOENT") return null;
          throw error;
        }
      })
    )).filter(Boolean);
    const active = retainedFiles.find((item) => item.name === "app.log");
    return {
      content: includeRotated
        ? retainedFiles.map((item) => item.content).filter(Boolean).join("\n")
        : active?.content || "",
      metadata: {
        activeBytes: active?.stats.size || 0,
        activeMaximumBytes,
        maximumFiles,
        retainedFileCount: retainedFiles.length,
        retainedBytes: retainedFiles.reduce((sum, item) => sum + item.stats.size, 0),
      },
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        content: "",
        metadata: {
          activeBytes: 0,
          activeMaximumBytes,
          maximumFiles,
          retainedFileCount: 0,
          retainedBytes: 0,
        },
      };
    }
    throw error;
  }
}

export async function getReadPipelineTimeline(readId) {
  await requirePermission("system.view_audit");
  try {
    const pool = await getPool();
    const data = await queryReadPipelineTimeline(
      (text, values) => pool.query(text, values),
      readId,
    );
    return { success: true, data };
  } catch (error) {
    readPipelineLogger.error("read_pipeline_timeline_query_failed", {
      readId,
      errorCode: error?.code || "READ_PIPELINE_TIMELINE_QUERY_FAILED",
    });
    return { success: false, error: "Failed to read the plate-read pipeline timeline" };
  }
}

export async function getIntegrationIngressReceipts(filters = {}) {
  await requirePermission("system.view_audit");
  try {
    const pool = await getPool();
    const data = await queryIntegrationIngressReceipts(
      (text, values) => pool.query(text, values),
      filters
    );
    return { success: true, data };
  } catch (error) {
    ingressReceiptsLogger.error("integration_ingress_receipt_query_failed", {
      errorCode: error?.code || "INGRESS_RECEIPT_QUERY_FAILED",
    });
    return { success: false, error: "Failed to read integration ingress receipts" };
  }
}

export async function getSystemLogs(filters = {}) {
  await requirePermission("system.view_audit");
  try {
    const { content, metadata } = await readOperationalLogFile();

    return {
      success: true,
      data: querySystemLogText(content, filters, {
        fileBytes: metadata.activeBytes,
        maxFileBytes: metadata.activeMaximumBytes,
        maxFiles: metadata.maximumFiles,
      }),
    };
  } catch (error) {
    systemLogsLogger.error("system_log_read_failed", {
      errorCode: error?.code || "LOG_READ_FAILED",
    });
    return { success: false, error: "Failed to read system logs" };
  }
}

function loggingRetentionFailure(error, fallback) {
  const safeMessage = String(error?.message || "");
  if (
    error instanceof TypeError
    && /^(Incident name|Request ID|A positive read ID|A valid incident time window|Incident time windows|Incident scope|Type ARCHIVE LOG EVIDENCE|Logging retention preview|Logging retention candidates)/.test(safeMessage)
  ) {
    return { success: false, error: safeMessage };
  }
  loggingRetentionLogger.error("logging_retention_action_failed", {
    errorCode: error?.code || "LOGGING_RETENTION_ACTION_FAILED",
  });
  return { success: false, error: fallback };
}

export async function getLoggingRetentionOverview() {
  await requirePermission("system.view_audit");
  try {
    const pool = await getPool();
    const { content, metadata } = await readOperationalLogFile({ includeRotated: true });
    const activeLog = querySystemLogText(content, { pageSize: 25 }, {
      fileBytes: metadata.activeBytes,
      maxFileBytes: metadata.activeMaximumBytes,
      maxFiles: metadata.maximumFiles,
    });
    const data = await loadLoggingRetentionOverview({
      query: (text, values) => pool.query(text, values),
      logMetadata: {
        ...metadata,
        oldestTimestamp: activeLog.metadata.oldestTimestamp,
        newestTimestamp: activeLog.metadata.newestTimestamp,
      },
    });
    data.operationalLog.retainedFileCount = metadata.retainedFileCount;
    data.operationalLog.retainedBytes = metadata.retainedBytes;
    return { success: true, data };
  } catch (error) {
    return loggingRetentionFailure(error, "Unable to read logging retention health.");
  }
}

export async function createLoggingIncident(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  const now = new Date();
  try {
    const normalized = normalizeLoggingIncidentInput(input, now);
    const { content } = await readOperationalLogFile({ includeRotated: true });
    const operationalSnapshot = querySystemLogIncident(
      content,
      operationalFiltersForIncident(normalized),
    );
    const pool = await getPool();
    const data = await createLoggingIncidentService({
      executor: pool,
      actor: principal,
      input: normalized,
      operationalEntries: operationalSnapshot.entries,
      now,
    });
    revalidatePath("/logs/retention");
    return { success: true, data };
  } catch (error) {
    return loggingRetentionFailure(error, "Unable to create the incident evidence package.");
  }
}

export async function previewLoggingRetention() {
  const principal = await requirePermission("maintenance.manage");
  try {
    const pool = await getPool();
    const data = await createLoggingRetentionPreviewService({
      query: (text, values) => pool.query(text, values),
      actor: principal,
    });
    revalidatePath("/logs/retention");
    return { success: true, data };
  } catch (error) {
    return loggingRetentionFailure(error, "Unable to create a logging retention preview.");
  }
}

export async function executeLoggingRetention(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const pool = await getPool();
    const data = await executeLoggingRetentionPreviewService({
      executor: pool,
      actor: principal,
      previewToken: input.previewToken,
      confirmation: input.confirmation,
    });
    revalidatePath("/logs/retention");
    revalidatePath("/logs/receipts");
    return { success: true, data };
  } catch (error) {
    return loggingRetentionFailure(error, "Unable to execute logging retention.");
  }
}

export async function dbBackfill() {
  await requirePermission("maintenance.manage");
  return await updateActions.dbBackfill();
}

export async function migrateImageDataToFiles() {
  await requirePermission("maintenance.manage");
  return await updateActions.migrateImageDataToFiles();
}

export async function clearImageData() {
  await requirePermission("maintenance.manage");
  return await updateActions.clearImageData();
}

export async function checkUpdateRequired() {
  await requirePermission("maintenance.manage");
  try {
    const updateStatus = await checkUpdateStatus();
    return !updateStatus;
  } catch (error) {
    console.error("Error checking update status:", error);
    return false;
  }
}

export async function completeUpdate() {
  await requirePermission("maintenance.manage");
  return await updateActions.completeUpdate();
}

export async function skipImageMigration() {
  await requirePermission("maintenance.manage");
  return await updateActions.skipImageMigration();
}

export async function validatePlateRecord(readId, value) {
  const principal = await requirePermission("plate.review");
  try {
    const data = await getPlateReviewRepository().reviewRead({
      readId,
      action: value ? "confirm" : "reopen",
      reason: value ? "human_confirmation" : "reopened_for_review",
      actor: principal,
    });
    revalidatePath("/live_feed");
    return { success: true, data };
  } catch (error) {
    return plateReviewActionFailure(error, "Failed to update the plate review.");
  }
}

export async function addDBPlate(plate_number, flagged = false, monitoring = {}) {
  await requirePermission("plate.review");
  try {
    await addUnseenPlate(plate_number, flagged, monitoring);
    revalidatePath("/flagged");
    revalidatePath("/known_plates");
    return { success: true };
  } catch (error) {
    console.error("Error adding plate:", error);
    return { success: false, error: "Failed to add plate" };
  }
}

function visualSearchFailure(error, fallback) {
  const safeCodes = new Set([
    "CAPTURE_NOT_FOUND",
    "IMAGE_DECODE_FAILED",
    "IMAGE_INDEX_FAILED",
    "INVALID_SEARCH_FILTER",
    "INVALID_CAMERA_PROFILE",
    "INVALID_VISUAL_UPLOAD",
    "SOURCE_IMAGE_MISSING",
    "UPLOAD_TOO_LARGE",
    "INVALID_VEHICLE_MATCH_LABEL",
    "INVALID_VEHICLE_MATCH_PAIR",
    "VEHICLE_MATCH_ASSET_UNAVAILABLE",
    "VEHICLE_MATCH_MODEL_MISMATCH",
    "INVALID_VEHICLE_REID_V2_REVIEW_LABEL",
    "INVALID_VEHICLE_REID_V2_REVIEW_PAIR",
    "VEHICLE_REID_V2_REVIEW_UNAVAILABLE",
    "VEHICLE_REID_V2_REVIEW_SOURCE_CHANGED",
    "VEHICLE_REID_V2_REVIEW_MODEL_MISMATCH",
    "VEHICLE_REID_V2_REVIEW_EMBEDDING_INVALID",
    "VEHICLE_REID_V2_SEARCH_MODE_CHANGED",
    "VEHICLE_REID_V2_SEARCH_SOURCE_CHANGED",
    "INVALID_DIRECTION_PROFILE",
    "INVALID_VEHICLE_ORIENTATION",
    "VEHICLE_DIRECTION_ASSET_UNAVAILABLE",
    "INVALID_VEHICLE_CLUSTER_REVIEW",
    "VEHICLE_CLUSTER_ASSIGNMENT_NOT_FOUND",
  ]);
  if (safeCodes.has(error?.code)) return { success: false, error: error.message };
  console.error(fallback, { code: String(error?.code || "") });
  return { success: false, error: fallback };
}

export async function getVisualSearchBootstrap(input = {}) {
  const principal = await requirePermission("plate.read");
  try {
    const canManageIndex = hasPermission(principal, "maintenance.manage");
    const [data, config] = await Promise.all([
      (await getCaptureAssetService()).getBootstrap({
        includeCameraSetup: canManageIndex && input?.includeCameraSetup === true,
      }),
      canManageIndex ? getConfig() : Promise.resolve(null),
    ]);
    const visualIndexSettings = canManageIndex
      ? normalizeVisualIndexSettings(config?.visualIndex)
      : null;
    return {
      success: true,
      data: {
        ...data,
        canManageIndex,
        canReviewMatches: hasPermission(principal, "plate.review"),
        ...(visualIndexSettings ? {
          visualIndex: {
            settings: visualIndexSettings,
            pace: visualIndexPace(visualIndexSettings),
            runtime: getVisualIndexRuntimeStatus(),
          },
        } : {}),
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to load visual search.");
  }
}

export async function getVisualSearchCameraSetup() {
  await requirePermission("maintenance.manage");
  try {
    return {
      success: true,
      data: await (await getCaptureAssetService()).getCameraSetup(),
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to load camera detector setup.");
  }
}

export async function indexCaptureAssetsBatch(batchSize = 20) {
  await requirePermission("maintenance.manage");
  try {
    const data = await (await getCaptureAssetService()).indexBatch({ limit: batchSize });
    revalidatePath("/visual_search");
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to index capture images.");
  }
}

export async function updateVisualIndexSettings(input = {}) {
  await requirePermission("maintenance.manage");
  try {
    const currentConfig = await getConfig();
    let visualIndex = normalizeVisualIndexSettings(currentConfig.visualIndex);
    if (input.pace !== undefined) {
      visualIndex = applyVisualIndexPace(visualIndex, String(input.pace));
    }
    if (input.paused !== undefined) {
      visualIndex = normalizeVisualIndexSettings({
        ...visualIndex,
        paused: input.paused === true,
      });
    }
    const result = await saveConfig({ ...currentConfig, visualIndex });
    if (!result.success) return result;
    wakeVisualIndexWorker();
    revalidatePath("/visual_search");
    return {
      success: true,
      data: {
        settings: visualIndex,
        pace: visualIndexPace(visualIndex),
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to update automatic indexing.");
  }
}

export async function saveCameraVisualProfile(input = {}) {
  await requirePermission("maintenance.manage");
  try {
    const data = await (await getCaptureAssetService()).saveCameraProfile(input);
    revalidatePath("/visual_search");
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to save the camera crop profile.");
  }
}

export async function indexCameraCaptureAssetsBatch(cameraName, batchSize = 20) {
  await requirePermission("maintenance.manage");
  try {
    const data = await (await getCaptureAssetService()).indexCameraBatch({
      cameraName,
      limit: batchSize,
    });
    revalidatePath("/visual_search");
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to reindex this camera.");
  }
}

export async function findSimilarCaptures(input = {}) {
  await requirePermission("plate.read");
  try {
    const data = await (await getCaptureAssetService()).search({
      readId: input.readId,
      cameraNames: Array.isArray(input.cameraNames) ? input.cameraNames : [],
      startDate: input.startDate || null,
      endDate: input.endDate || null,
      limit: input.limit,
    });
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to search capture images.");
  }
}

export async function findSimilarUploadedCaptures(input = {}) {
  await requirePermission("plate.read");
  try {
    const data = await (await getCaptureAssetService()).searchUpload({
      dataUrl: input.dataUrl,
      fileName: input.fileName,
      cameraNames: Array.isArray(input.cameraNames) ? input.cameraNames : [],
      startDate: input.startDate || null,
      endDate: input.endDate || null,
      limit: input.limit,
    });
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to search the uploaded image.");
  }
}

export async function submitVehicleMatchFeedback(input = {}) {
  const principal = await requirePermission("plate.review");
  try {
    const data = await (await getCaptureAssetService()).recordMatchFeedback({
      sourceReadId: input.sourceReadId,
      candidateReadId: input.candidateReadId,
      label: input.label,
      actor: principal,
    });
    revalidatePath("/visual_search");
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to save vehicle match feedback.");
  }
}

function canonicalCatalogCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function canonicalCatalogInstant(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function canonicalCatalogRunData(run) {
  if (!run) return null;
  const raw = run.counts || {};
  const value = (key) => canonicalCatalogCount(raw[key]);
  const candidateReads = canonicalCatalogCount(run.candidate_reads);
  const materialized = value("total");
  const unmaterialized = run.phase === "preview"
    ? Math.max(0, candidateReads - materialized)
    : 0;
  return {
    id: Number(run.id),
    status: run.status,
    phase: run.phase,
    previewFingerprint: run.preview_fingerprint || null,
    maxReadId: canonicalCatalogCount(run.max_read_id),
    previewCursorReadId: canonicalCatalogCount(run.preview_cursor_read_id),
    batchSize: canonicalCatalogCount(run.batch_size),
    createdAt: canonicalCatalogInstant(run.created_at),
    updatedAt: canonicalCatalogInstant(run.updated_at),
    confirmedAt: canonicalCatalogInstant(run.confirmed_at),
    pausedAt: canonicalCatalogInstant(run.paused_at),
    cancelledAt: canonicalCatalogInstant(run.cancelled_at),
    completedAt: canonicalCatalogInstant(run.completed_at),
    counts: {
      total: candidateReads,
      pendingPreview: value("pending_preview") + unmaterialized,
      previewing: value("previewing"),
      previewed: value("previewed"),
      queued: value("queued"),
      processing: value("processing"),
      cataloged: value("cataloged"),
      alreadyCurrent: value("already_current"),
      superseded: value("superseded"),
      unavailable: value("unavailable"),
      invalid: value("invalid"),
      failed: value("failed"),
      cancelled: value("cancelled"),
      retryable: value("retryable"),
      identityEligible: value("identity_eligible"),
      displayOnly: value("display_only"),
      uniqueHashes: value("unique_hashes"),
      logicalSourceBytes: value("logical_source_bytes"),
      uniqueBytes: value("unique_bytes"),
      existingAssetBytes: value("existing_asset_bytes"),
      projectedNewBytes: value("projected_new_bytes"),
      duplicateBytesAvoided: value("duplicate_bytes_avoided"),
      currentLinks: value("cataloged") + value("already_current"),
      staleLinks: value("stale_links"),
      missingLinks: value("missing_links"),
    },
  };
}

function canonicalCatalogOverviewData(overview, worker) {
  const catalog = overview?.catalog || {};
  const live = overview?.live || {};
  const liveCounts = live?.counts || {};
  return {
    worker: {
      phase: worker?.phase || "starting",
      lastError: worker?.lastError?.message || null,
      lastBatch: worker?.lastBatch || null,
    },
    retention: {
      policy: "archival",
      zeroLinkAssetCount: canonicalCatalogCount(
        overview?.retention?.zeroLinkAssetCount ?? catalog.zero_link_asset_count
      ),
      zeroLinkAssetBytes: canonicalCatalogCount(
        overview?.retention?.zeroLinkAssetBytes ?? catalog.zero_link_asset_bytes
      ),
    },
    catalog: {
      eligibleReads: canonicalCatalogCount(catalog.eligible_reads),
      currentLinks: canonicalCatalogCount(catalog.current_links),
      staleLinks: canonicalCatalogCount(catalog.stale_links),
      assetCount: canonicalCatalogCount(catalog.asset_count),
      assetBytes: canonicalCatalogCount(catalog.asset_bytes),
      readLinks: canonicalCatalogCount(catalog.read_links),
      identityEligibleLinks: canonicalCatalogCount(catalog.identity_eligible_links),
      displayOnlyLinks: canonicalCatalogCount(catalog.display_only_links),
    },
    latestRun: canonicalCatalogRunData(overview?.latestRun),
    retryCandidates: (overview?.retryCandidates || []).map((item) => ({
      jobId: Number(item.id),
      readId: Number(item.read_id),
      errorCode: item.error_code || "VEHICLE_IMAGE_ASSET_CATALOG_FAILED",
      failureStage: item.failure_stage || null,
      operatorRetryCount: canonicalCatalogCount(item.operator_retry_count),
    })),
    live: {
      state: live.state || "unavailable",
      enabled: live.enabled === true,
      completedCampaign: live.completedCampaign === true,
      activeCampaign: live.activeCampaign === true,
      counts: {
        totalJobs: canonicalCatalogCount(liveCounts.total_jobs),
        queued: canonicalCatalogCount(liveCounts.queued),
        processing: canonicalCatalogCount(liveCounts.processing),
        cataloged: canonicalCatalogCount(liveCounts.cataloged),
        superseded: canonicalCatalogCount(liveCounts.superseded),
        unavailable: canonicalCatalogCount(liveCounts.unavailable),
        invalid: canonicalCatalogCount(liveCounts.invalid),
        failed: canonicalCatalogCount(liveCounts.failed),
        retryable: canonicalCatalogCount(liveCounts.retryable),
        pendingEligible: canonicalCatalogCount(liveCounts.pending_eligible),
        lastCatalogedAt: liveCounts.last_cataloged_at || null,
      },
      retryCandidates: (live.retryCandidates || []).map((item) => ({
        jobId: Number(item.id),
        readId: Number(item.read_id),
        errorCode: item.error_code || "VEHICLE_IMAGE_ASSET_LIVE_CATALOG_FAILED",
        operatorRetryCount: canonicalCatalogCount(item.operator_retry_count),
      })),
    },
  };
}

function canonicalCatalogActionFailure(error, fallback) {
  const message = String(error?.message || "").trim();
  if (/^(Canonical Overview|Automatic canonical Overview|Complete the initial canonical Overview|Disable automatic canonical Overview|The exact canonical Overview|Wait for (?:the current|active) canonical Overview|Only a terminal (?:catalog|automatic catalog)|This (?:catalog|automatic catalog) item|A cancelled canonical Overview)/.test(message)) {
    return { success: false, error: message };
  }
  console.error(fallback, { code: String(error?.code || "") });
  return { success: false, error: fallback };
}

async function loadCanonicalCatalogOverview(runtime) {
  const overview = await runtime.service.getOverview();
  return canonicalCatalogOverviewData(overview, getVehicleImageAssetCatalogWorkerStatus());
}

export async function getVehicleImageAssetCatalogOverview() {
  await requirePermission("system.manage_settings");
  try {
    const runtime = await getVehicleImageAssetCatalogRuntime();
    return { success: true, data: { overview: await loadCanonicalCatalogOverview(runtime) } };
  } catch (error) {
    return canonicalCatalogActionFailure(error, "Unable to load the canonical Overview catalog.");
  }
}

export async function previewVehicleImageAssetCatalog() {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageAssetCatalogRuntime();
    await runtime.service.createPreview({ actorUserId: principal.id });
    wakeVehicleImageAssetCatalogWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadCanonicalCatalogOverview(runtime) } };
  } catch (error) {
    return canonicalCatalogActionFailure(error, "Unable to create the canonical Overview preview.");
  }
}

export async function confirmVehicleImageAssetCatalogBatch(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageAssetCatalogRuntime();
    const confirmation = await runtime.service.confirmBatch({
      runId: input.runId,
      previewFingerprint: input.previewFingerprint,
      limit: input.limit,
      actorUserId: principal.id,
    });
    wakeVehicleImageAssetCatalogWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return {
      success: true,
      data: {
        confirmation,
        overview: await loadCanonicalCatalogOverview(runtime),
      },
    };
  } catch (error) {
    return canonicalCatalogActionFailure(error, "Unable to confirm this canonical Overview batch.");
  }
}

export async function setVehicleImageAssetCatalogPaused(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageAssetCatalogRuntime();
    await runtime.service.setPaused({
      runId: input.runId,
      paused: input.paused === true,
      actorUserId: principal.id,
    });
    if (input.paused !== true) wakeVehicleImageAssetCatalogWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadCanonicalCatalogOverview(runtime) } };
  } catch (error) {
    return canonicalCatalogActionFailure(error, "Unable to update canonical Overview catalog processing.");
  }
}

export async function cancelVehicleImageAssetCatalog(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageAssetCatalogRuntime();
    await runtime.service.cancel({ runId: input.runId, actorUserId: principal.id });
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadCanonicalCatalogOverview(runtime) } };
  } catch (error) {
    return canonicalCatalogActionFailure(error, "Unable to cancel canonical Overview catalog processing.");
  }
}

export async function retryVehicleImageAssetCatalogJob(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageAssetCatalogRuntime();
    await runtime.service.retryItem({ jobId: input.jobId, actorUserId: principal.id });
    wakeVehicleImageAssetCatalogWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadCanonicalCatalogOverview(runtime) } };
  } catch (error) {
    return canonicalCatalogActionFailure(error, "Unable to retry this canonical Overview catalog item.");
  }
}

export async function setVehicleImageAssetLiveCatalogEnabled(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageAssetCatalogRuntime();
    await runtime.service.setLiveEnabled({
      enabled: input.enabled === true,
      actorUserId: principal.id,
    });
    if (input.enabled === true) wakeVehicleImageAssetCatalogWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadCanonicalCatalogOverview(runtime) } };
  } catch (error) {
    return canonicalCatalogActionFailure(
      error,
      "Unable to update automatic canonical Overview cataloging."
    );
  }
}

export async function retryVehicleImageAssetLiveCatalogJob(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageAssetCatalogRuntime();
    await runtime.service.retryLiveJob({ jobId: input.jobId, actorUserId: principal.id });
    wakeVehicleImageAssetCatalogWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadCanonicalCatalogOverview(runtime) } };
  } catch (error) {
    return canonicalCatalogActionFailure(
      error,
      "Unable to retry this automatic canonical Overview item."
    );
  }
}

function vehicleCropCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function vehicleCropOverviewData(overview) {
  const catalog = overview?.catalog || {};
  const counts = overview?.counts || {};
  const run = overview?.latestRun || null;
  const live = overview?.live || null;
  return {
    algorithmVersion: overview?.algorithmVersion || null,
    catalog: {
      eligibleAssets: vehicleCropCount(catalog.eligible_assets),
      cropCount: vehicleCropCount(catalog.crop_count),
      physicalFiles: vehicleCropCount(catalog.physical_files),
      cropBytes: vehicleCropCount(catalog.crop_bytes),
    },
    latestRun: run ? {
      id: Number(run.id),
      status: run.status,
      maxAssetId: vehicleCropCount(run.max_asset_id),
      previewFingerprint: run.preview_fingerprint || null,
      batchSize: vehicleCropCount(run.batch_size),
      createdAt: run.created_at || null,
      completedAt: run.completed_at || null,
      counts: {
        total: vehicleCropCount(counts.total),
        pendingPreview: vehicleCropCount(counts.pending_preview),
        previewing: vehicleCropCount(counts.previewing),
        previewed: vehicleCropCount(counts.previewed),
        queued: vehicleCropCount(counts.queued),
        processing: vehicleCropCount(counts.processing),
        ready: vehicleCropCount(counts.ready),
        alreadyCurrent: vehicleCropCount(counts.already_current),
        sourceChanged: vehicleCropCount(counts.source_changed),
        invalid: vehicleCropCount(counts.invalid),
        failed: vehicleCropCount(counts.failed),
        retryable: vehicleCropCount(counts.retryable),
        uniqueCrops: vehicleCropCount(counts.unique_crops),
        projectedBytes: vehicleCropCount(counts.projected_bytes),
        sourcePixels: vehicleCropCount(counts.source_pixels),
        cropPixels: vehicleCropCount(counts.crop_pixels),
      },
    } : null,
    retryCandidates: (overview?.retryCandidates || []).map((item) => ({
      jobId: Number(item.id),
      assetId: Number(item.asset_id),
      failureStage: item.failure_stage || null,
      errorCode: item.error_code || "VEHICLE_IMAGE_CROP_FAILED",
      operatorRetryCount: vehicleCropCount(item.operator_retry_count),
    })),
    samples: (overview?.samples || []).map((item) => ({
      assetId: Number(item.asset_id),
      imageUrl: `/images/${String(item.storage_path || "").replaceAll("\\", "/")}`,
      width: vehicleCropCount(item.image_width),
      height: vehicleCropCount(item.image_height),
      createdAt: item.created_at || null,
    })),
    live: live ? {
      enabled: live.enabled === true,
      state: live.state || "disabled",
      completedCampaign: live.completedCampaign === true,
      activeCampaign: live.activeCampaign === true,
      counts: {
        totalJobs: vehicleCropCount(live.counts?.total_jobs),
        pendingEligible: vehicleCropCount(live.counts?.pending_eligible),
        queued: vehicleCropCount(live.counts?.queued),
        processing: vehicleCropCount(live.counts?.processing),
        ready: vehicleCropCount(live.counts?.ready),
        alreadyCurrent: vehicleCropCount(live.counts?.already_current),
        sourceChanged: vehicleCropCount(live.counts?.source_changed),
        unavailable: vehicleCropCount(live.counts?.unavailable),
        invalid: vehicleCropCount(live.counts?.invalid),
        failed: vehicleCropCount(live.counts?.failed),
        retryable: vehicleCropCount(live.counts?.retryable),
        lastCompletedAt: live.counts?.last_completed_at || null,
      },
      retryCandidates: (live.retryCandidates || []).map((item) => ({
        jobId: Number(item.id),
        assetId: Number(item.asset_id),
        errorCode: item.error_code || "VEHICLE_IMAGE_CROP_LIVE_FAILED",
        operatorRetryCount: vehicleCropCount(item.operator_retry_count),
      })),
    } : null,
    worker: getVehicleImageCropWorkerStatus(),
  };
}

function vehicleCropActionFailure(error, fallback) {
  const message = String(error?.message || "").trim();
  if (/^(Vehicle crop|Canonical Overview crop|Automatic vehicle crop|Complete the initial vehicle crop|Disable automatic vehicle crop|Wait for (?:the current|the active|an active) vehicle crop|Only a terminal automatic vehicle crop|This automatic vehicle crop)/.test(message)) {
    return { success: false, error: message };
  }
  console.error(fallback, { code: String(error?.code || "") });
  return { success: false, error: fallback };
}

async function loadVehicleCropOverview(runtime) {
  return vehicleCropOverviewData(await runtime.service.getOverview());
}

export async function getVehicleImageCropOverview() {
  await requirePermission("system.manage_settings");
  try {
    const runtime = await getVehicleImageCropRuntime();
    return { success: true, data: { overview: await loadVehicleCropOverview(runtime) } };
  } catch (error) {
    return vehicleCropActionFailure(error, "Unable to load canonical Overview vehicle crops.");
  }
}

export async function previewVehicleImageCrops() {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageCropRuntime();
    await runtime.service.createPreview({ actorUserId: principal.id });
    wakeVehicleImageCropWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleCropOverview(runtime) } };
  } catch (error) {
    return vehicleCropActionFailure(error, "Unable to create the vehicle crop preview.");
  }
}

export async function confirmVehicleImageCropBatch(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageCropRuntime();
    const confirmation = await runtime.service.confirmBatch({
      runId: input.runId,
      previewFingerprint: input.previewFingerprint,
      limit: input.limit,
      actorUserId: principal.id,
    });
    wakeVehicleImageCropWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return {
      success: true,
      data: { confirmation, overview: await loadVehicleCropOverview(runtime) },
    };
  } catch (error) {
    return vehicleCropActionFailure(error, "Unable to confirm this vehicle crop batch.");
  }
}

export async function setVehicleImageCropPaused(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageCropRuntime();
    await runtime.service.setPaused({
      runId: input.runId,
      paused: input.paused === true,
      actorUserId: principal.id,
    });
    if (input.paused !== true) wakeVehicleImageCropWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleCropOverview(runtime) } };
  } catch (error) {
    return vehicleCropActionFailure(error, "Unable to change vehicle crop processing.");
  }
}

export async function cancelVehicleImageCropCampaign(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageCropRuntime();
    await runtime.service.cancel({ runId: input.runId, actorUserId: principal.id });
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleCropOverview(runtime) } };
  } catch (error) {
    return vehicleCropActionFailure(error, "Unable to cancel vehicle crop processing.");
  }
}

export async function retryVehicleImageCropJob(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageCropRuntime();
    await runtime.service.retryJob({ jobId: input.jobId, actorUserId: principal.id });
    wakeVehicleImageCropWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleCropOverview(runtime) } };
  } catch (error) {
    return vehicleCropActionFailure(error, "Unable to retry this vehicle crop item.");
  }
}

export async function setVehicleImageCropLiveEnabled(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageCropRuntime();
    await runtime.service.setLiveEnabled({
      enabled: input.enabled === true,
      actorUserId: principal.id,
    });
    if (input.enabled === true) wakeVehicleImageCropWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleCropOverview(runtime) } };
  } catch (error) {
    return vehicleCropActionFailure(error, "Unable to update automatic vehicle cropping.");
  }
}

export async function retryVehicleImageCropLiveJob(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleImageCropRuntime();
    await runtime.service.retryLiveJob({
      jobId: input.jobId,
      actorUserId: principal.id,
    });
    wakeVehicleImageCropWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleCropOverview(runtime) } };
  } catch (error) {
    return vehicleCropActionFailure(
      error,
      "Unable to retry this automatic vehicle crop."
    );
  }
}

function vehicleAssetEmbeddingCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function vehicleAssetEmbeddingOverviewData(overview) {
  const catalog = overview?.catalog || {};
  const counts = overview?.counts || {};
  const run = overview?.latestRun || null;
  return {
    modelName: overview?.modelName || null,
    algorithmVersion: overview?.algorithmVersion || null,
    catalog: {
      eligibleCrops: vehicleAssetEmbeddingCount(catalog.eligible_crops),
      embeddingCount: vehicleAssetEmbeddingCount(catalog.embedding_count),
      embeddingBytes: vehicleAssetEmbeddingCount(catalog.embedding_bytes),
    },
    latestRun: run ? {
      id: Number(run.id),
      status: run.status,
      maxDerivativeId: vehicleAssetEmbeddingCount(run.max_derivative_id),
      modelName: run.model_name,
      algorithmVersion: run.algorithm_version,
      previewFingerprint: run.preview_fingerprint || null,
      batchSize: vehicleAssetEmbeddingCount(run.batch_size),
      createdAt: run.created_at || null,
      completedAt: run.completed_at || null,
      counts: {
        total: vehicleAssetEmbeddingCount(counts.total),
        pendingPreview: vehicleAssetEmbeddingCount(counts.pending_preview),
        previewing: vehicleAssetEmbeddingCount(counts.previewing),
        previewed: vehicleAssetEmbeddingCount(counts.previewed),
        queued: vehicleAssetEmbeddingCount(counts.queued),
        processing: vehicleAssetEmbeddingCount(counts.processing),
        ready: vehicleAssetEmbeddingCount(counts.ready),
        alreadyCurrent: vehicleAssetEmbeddingCount(counts.already_current),
        sourceChanged: vehicleAssetEmbeddingCount(counts.source_changed),
        invalid: vehicleAssetEmbeddingCount(counts.invalid),
        failed: vehicleAssetEmbeddingCount(counts.failed),
        retryable: vehicleAssetEmbeddingCount(counts.retryable),
      },
    } : null,
    retryCandidates: (overview?.retryCandidates || []).map((item) => ({
      jobId: Number(item.id),
      derivativeId: Number(item.derivative_id),
      assetId: Number(item.asset_id),
      failureStage: item.failure_stage || null,
      errorCode: item.error_code || "VEHICLE_ASSET_EMBEDDING_FAILED",
      errorMessage: item.error_details?.message || null,
      operatorRetryCount: vehicleAssetEmbeddingCount(item.operator_retry_count),
    })),
    worker: getVehicleAssetEmbeddingWorkerStatus(),
  };
}

function vehicleAssetEmbeddingActionFailure(error, fallback) {
  const message = String(error?.message || "").trim();
  if (/^(Crop embedding|Canonical crop embedding|Embedding batches|Wait for the current crop embedding)/.test(message)) {
    return { success: false, error: message };
  }
  console.error(fallback, { code: String(error?.code || "") });
  return { success: false, error: fallback };
}

async function loadVehicleAssetEmbeddingOverview(runtime) {
  return vehicleAssetEmbeddingOverviewData(await runtime.service.getOverview());
}

export async function getVehicleAssetEmbeddingOverview() {
  await requirePermission("system.manage_settings");
  try {
    const runtime = await getVehicleAssetEmbeddingRuntime();
    return { success: true, data: { overview: await loadVehicleAssetEmbeddingOverview(runtime) } };
  } catch (error) {
    return vehicleAssetEmbeddingActionFailure(error, "Unable to load canonical crop embeddings.");
  }
}

export async function previewVehicleAssetEmbeddings() {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleAssetEmbeddingRuntime();
    await runtime.service.createPreview({ actorUserId: principal.id });
    wakeVehicleAssetEmbeddingWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleAssetEmbeddingOverview(runtime) } };
  } catch (error) {
    return vehicleAssetEmbeddingActionFailure(error, "Unable to create the crop embedding preview.");
  }
}

export async function confirmVehicleAssetEmbeddingBatch(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleAssetEmbeddingRuntime();
    const confirmation = await runtime.service.confirmBatch({
      runId: input.runId,
      previewFingerprint: input.previewFingerprint,
      limit: input.limit,
      actorUserId: principal.id,
    });
    wakeVehicleAssetEmbeddingWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return {
      success: true,
      data: { confirmation, overview: await loadVehicleAssetEmbeddingOverview(runtime) },
    };
  } catch (error) {
    return vehicleAssetEmbeddingActionFailure(error, "Unable to confirm this crop embedding batch.");
  }
}

export async function setVehicleAssetEmbeddingPaused(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleAssetEmbeddingRuntime();
    await runtime.service.setPaused({
      runId: input.runId,
      paused: input.paused === true,
      actorUserId: principal.id,
    });
    if (input.paused !== true) wakeVehicleAssetEmbeddingWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleAssetEmbeddingOverview(runtime) } };
  } catch (error) {
    return vehicleAssetEmbeddingActionFailure(error, "Unable to change crop embedding processing.");
  }
}

export async function cancelVehicleAssetEmbeddingCampaign(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleAssetEmbeddingRuntime();
    await runtime.service.cancel({ runId: input.runId, actorUserId: principal.id });
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleAssetEmbeddingOverview(runtime) } };
  } catch (error) {
    return vehicleAssetEmbeddingActionFailure(error, "Unable to cancel crop embedding processing.");
  }
}

export async function retryVehicleAssetEmbeddingJob(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleAssetEmbeddingRuntime();
    await runtime.service.retryJob({ jobId: input.jobId, actorUserId: principal.id });
    wakeVehicleAssetEmbeddingWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleAssetEmbeddingOverview(runtime) } };
  } catch (error) {
    return vehicleAssetEmbeddingActionFailure(error, "Unable to retry this crop embedding item.");
  }
}

function vehicleAssetAttributeCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function vehicleAssetAttributeOverviewData(overview) {
  const catalog = overview?.catalog || {};
  const counts = overview?.counts || {};
  const run = overview?.latestRun || null;
  return {
    contracts: overview?.contracts || [],
    algorithmVersion: overview?.algorithmVersion || null,
    catalog: {
      eligibleCrops: vehicleAssetAttributeCount(catalog.eligible_crops),
      fullyObservedCrops: vehicleAssetAttributeCount(catalog.fully_observed_crops),
      observationCount: vehicleAssetAttributeCount(catalog.observation_count),
      colorReady: vehicleAssetAttributeCount(catalog.color_ready),
      colorUnknown: vehicleAssetAttributeCount(catalog.color_unknown),
      bodyTypeReady: vehicleAssetAttributeCount(catalog.body_type_ready),
      bodyTypeUnknown: vehicleAssetAttributeCount(catalog.body_type_unknown),
    },
    latestRun: run ? {
      id: Number(run.id),
      status: run.status,
      maxDerivativeId: vehicleAssetAttributeCount(run.max_derivative_id),
      algorithmVersion: run.algorithm_version,
      previewFingerprint: run.preview_fingerprint || null,
      batchSize: vehicleAssetAttributeCount(run.batch_size),
      createdAt: run.created_at || null,
      completedAt: run.completed_at || null,
      counts: {
        total: vehicleAssetAttributeCount(counts.total),
        pendingPreview: vehicleAssetAttributeCount(counts.pending_preview),
        previewing: vehicleAssetAttributeCount(counts.previewing),
        previewed: vehicleAssetAttributeCount(counts.previewed),
        queued: vehicleAssetAttributeCount(counts.queued),
        processing: vehicleAssetAttributeCount(counts.processing),
        ready: vehicleAssetAttributeCount(counts.ready),
        alreadyCurrent: vehicleAssetAttributeCount(counts.already_current),
        sourceChanged: vehicleAssetAttributeCount(counts.source_changed),
        invalid: vehicleAssetAttributeCount(counts.invalid),
        failed: vehicleAssetAttributeCount(counts.failed),
        retryable: vehicleAssetAttributeCount(counts.retryable),
      },
    } : null,
    retryCandidates: (overview?.retryCandidates || []).map((item) => ({
      jobId: Number(item.id),
      derivativeId: Number(item.derivative_id),
      assetId: Number(item.asset_id),
      failureStage: item.failure_stage || null,
      errorCode: item.error_code || "VEHICLE_ASSET_ATTRIBUTE_FAILED",
      errorMessage: item.error_details?.message || null,
      operatorRetryCount: vehicleAssetAttributeCount(item.operator_retry_count),
    })),
    worker: getVehicleAssetAttributeWorkerStatus(),
  };
}

function vehicleAssetAttributeActionFailure(error, fallback) {
  const message = String(error?.message || "").trim();
  if (/^(Crop attribute|Canonical crop attribute|Attribute batches|Wait for the current crop attribute)/.test(message)) {
    return { success: false, error: message };
  }
  console.error(fallback, { code: String(error?.code || "") });
  return { success: false, error: fallback };
}

async function loadVehicleAssetAttributeOverview(runtime) {
  return vehicleAssetAttributeOverviewData(await runtime.service.getOverview());
}

export async function getVehicleAssetAttributeOverview() {
  await requirePermission("system.manage_settings");
  try {
    const runtime = await getVehicleAssetAttributeRuntime();
    return { success: true, data: { overview: await loadVehicleAssetAttributeOverview(runtime) } };
  } catch (error) {
    return vehicleAssetAttributeActionFailure(error, "Unable to load canonical crop attributes.");
  }
}

export async function previewVehicleAssetAttributes() {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleAssetAttributeRuntime();
    await runtime.service.createPreview({ actorUserId: principal.id });
    wakeVehicleAssetAttributeWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleAssetAttributeOverview(runtime) } };
  } catch (error) {
    return vehicleAssetAttributeActionFailure(error, "Unable to create the crop attribute preview.");
  }
}

export async function confirmVehicleAssetAttributeBatch(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleAssetAttributeRuntime();
    const confirmation = await runtime.service.confirmBatch({
      runId: input.runId,
      previewFingerprint: input.previewFingerprint,
      limit: input.limit,
      actorUserId: principal.id,
    });
    wakeVehicleAssetAttributeWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return {
      success: true,
      data: { confirmation, overview: await loadVehicleAssetAttributeOverview(runtime) },
    };
  } catch (error) {
    return vehicleAssetAttributeActionFailure(error, "Unable to confirm this crop attribute batch.");
  }
}

export async function setVehicleAssetAttributePaused(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleAssetAttributeRuntime();
    await runtime.service.setPaused({
      runId: input.runId,
      paused: input.paused === true,
      actorUserId: principal.id,
    });
    if (input.paused !== true) wakeVehicleAssetAttributeWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleAssetAttributeOverview(runtime) } };
  } catch (error) {
    return vehicleAssetAttributeActionFailure(error, "Unable to change crop attribute processing.");
  }
}

export async function cancelVehicleAssetAttributeCampaign(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleAssetAttributeRuntime();
    await runtime.service.cancel({ runId: input.runId, actorUserId: principal.id });
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleAssetAttributeOverview(runtime) } };
  } catch (error) {
    return vehicleAssetAttributeActionFailure(error, "Unable to cancel crop attribute processing.");
  }
}

export async function retryVehicleAssetAttributeJob(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleAssetAttributeRuntime();
    await runtime.service.retryJob({ jobId: input.jobId, actorUserId: principal.id });
    wakeVehicleAssetAttributeWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleAssetAttributeOverview(runtime) } };
  } catch (error) {
    return vehicleAssetAttributeActionFailure(error, "Unable to retry this crop attribute item.");
  }
}

function vehicleReidV2ConversionActionFailure(error, fallback) {
  const code = String(error?.code || "");
  if (code.startsWith("VEHICLE_REID_V2_CONVERSION_")) {
    return { success: false, error: String(error.message || fallback) };
  }
  console.error(fallback, { code });
  return { success: false, error: fallback };
}

export async function getVehicleReidV2ConversionPreviewOverview() {
  await requirePermission("system.manage_settings");
  try {
    const overview = await loadVehicleReidV2OperatorOverview();
    return { success: true, data: { overview } };
  } catch (error) {
    return vehicleReidV2ConversionActionFailure(
      error,
      "Unable to load the ReID v2 conversion preview."
    );
  }
}

async function loadVehicleReidV2OperatorOverview({ authorityOverview } = {}) {
  const [conversion, authority] = await Promise.all([
    (await getVehicleReidV2ConversionService()).getOverview(),
    authorityOverview
      ? Promise.resolve(authorityOverview)
      : (await getVehicleReidV2AuthorityService()).getOverview(),
  ]);
  return {
    ...conversion,
    authorityHealth: authority,
    liveWorker: getVehicleReidV2LiveWorkerStatus(),
  };
}

export async function startVehicleReidV2ConversionPreview(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const data = await (await getVehicleReidV2ConversionService()).startPreview({
      actor: principal,
      batchSize: input.batchSize,
    });
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data };
  } catch (error) {
    return vehicleReidV2ConversionActionFailure(
      error,
      "Unable to start the ReID v2 conversion preview."
    );
  }
}

export async function processVehicleReidV2ConversionPreviewBatch(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const data = await (await getVehicleReidV2ConversionService()).processBatch({
      runId: input.runId,
      limit: input.limit,
      actor: principal,
    });
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data };
  } catch (error) {
    return vehicleReidV2ConversionActionFailure(
      error,
      "Unable to process this bounded ReID v2 preview batch."
    );
  }
}

export async function setVehicleReidV2ConversionPreviewPaused(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const data = await (await getVehicleReidV2ConversionService()).setPaused({
      runId: input.runId,
      paused: input.paused === true,
      actor: principal,
    });
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data };
  } catch (error) {
    return vehicleReidV2ConversionActionFailure(
      error,
      "Unable to pause or resume the ReID v2 conversion preview."
    );
  }
}

export async function cancelVehicleReidV2ConversionPreview(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const data = await (await getVehicleReidV2ConversionService()).cancel({
      runId: input.runId,
      actor: principal,
    });
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data };
  } catch (error) {
    return vehicleReidV2ConversionActionFailure(
      error,
      "Unable to cancel the ReID v2 conversion preview."
    );
  }
}

export async function retryVehicleReidV2ConversionPreviewJob(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const data = await (await getVehicleReidV2ConversionService()).retryJob({
      jobId: input.jobId,
      actor: principal,
    });
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data };
  } catch (error) {
    return vehicleReidV2ConversionActionFailure(
      error,
      "Unable to retry this ReID v2 conversion preview item."
    );
  }
}

export async function verifyVehicleReidV2ConversionPreview(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const data = await (await getVehicleReidV2ConversionService()).verifyCurrent({
      runId: input.runId,
      previewFingerprint: input.previewFingerprint,
      actor: principal,
    });
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data };
  } catch (error) {
    return vehicleReidV2ConversionActionFailure(
      error,
      "Unable to verify the ReID v2 conversion preview fingerprint."
    );
  }
}

function vehicleReidV2AuthorityActionFailure(error, fallback) {
  const code = String(error?.code || "");
  if (code.startsWith("VEHICLE_REID_V2_AUTHORITY_")
    || code.startsWith("VEHICLE_REID_V2_LIVE_")
    || code.startsWith("VEHICLE_REID_V1_PRODUCER_")) {
    return { success: false, error: String(error.message || fallback), code };
  }
  console.error(fallback, { code });
  return { success: false, error: fallback };
}

export async function getVehicleReidV2AuthorityOverview() {
  await requirePermission("system.manage_settings");
  try {
    const overview = await (await getVehicleReidV2AuthorityService()).getOverview();
    return {
      success: true,
      data: { overview: { ...overview, worker: getVehicleReidV2LiveWorkerStatus() } },
    };
  } catch (error) {
    return vehicleReidV2AuthorityActionFailure(error, "Unable to load authoritative ReID status.");
  }
}

export async function getVehicleReidAuthorityMode() {
  await requirePermission("plate.read");
  try {
    const control = await (await getVehicleReidV2AuthorityService()).getControl();
    return { success: true, data: { control } };
  } catch (error) {
    return vehicleReidV2AuthorityActionFailure(error, "Unable to resolve the ReID authority mode.");
  }
}

export async function getVehicleReidReviewOverview() {
  const principal = await requirePermission("plate.read");
  try {
    const runtime = await getVehicleReidV2LiveRuntime();
    return {
      success: true,
      data: {
        ...(await runtime.service.getReviewOverview()),
        canRetry: hasPermission(principal, "maintenance.manage"),
      },
    };
  } catch (error) {
    return vehicleReidV2AuthorityActionFailure(error, "Unable to load ReID review exceptions.");
  }
}

export async function retryVehicleReidLiveException(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleReidV2LiveRuntime();
    const operation = await runtime.service.retryException({
      readId: input.readId,
      actor: principal,
    });
    wakeVehicleReidV2LiveWorker();
    revalidatePath("/visual_search/review");
    revalidatePath("/settings/vehicle-intelligence/processing");
    return {
      success: true,
      data: { operation, ...(await runtime.service.getReviewOverview()) },
    };
  } catch (error) {
    return vehicleReidV2AuthorityActionFailure(error, "Unable to retry this ReID exception.");
  }
}

export async function acceptVehicleReidV2ConversionPreview(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const authority = await (await getVehicleReidV2AuthorityService()).acceptPreview({
      runId: input.runId,
      previewFingerprint: input.previewFingerprint,
      actor: principal,
    });
    revalidatePath("/settings/vehicle-intelligence/processing");
    return {
      success: true,
      data: {
        operation: authority.operation,
        overview: await loadVehicleReidV2OperatorOverview({
          authorityOverview: authority.overview,
        }),
      },
    };
  } catch (error) {
    return vehicleReidV2AuthorityActionFailure(error, "Unable to accept this frozen ReID preview.");
  }
}

export async function materializeVehicleReidV2ConversionPreview(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const authority = await (await getVehicleReidV2AuthorityService()).materializeAcceptedPreview({
      runId: input.runId,
      previewFingerprint: input.previewFingerprint,
      actor: principal,
    });
    revalidatePath("/settings/vehicle-intelligence/processing");
    revalidatePath("/visual_search/profiles");
    return {
      success: true,
      data: {
        operation: authority.operation,
        overview: await loadVehicleReidV2OperatorOverview({
          authorityOverview: authority.overview,
        }),
      },
    };
  } catch (error) {
    return vehicleReidV2AuthorityActionFailure(error, "Unable to materialize this accepted ReID preview.");
  }
}

export async function transitionVehicleReidAuthorityMode(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const authority = await (await getVehicleReidV2AuthorityService()).transitionMode({
      mode: input.mode,
      runId: input.runId,
      reason: input.reason,
      actor: principal,
    });
    revalidatePath("/settings/vehicle-intelligence/processing");
    revalidatePath("/visual_search");
    revalidatePath("/visual_search/profiles");
    revalidatePath("/visual_search/review");
    revalidatePath("/live_feed");
    revalidatePath("/database");
    wakeVehicleReidV2LiveWorker();
    return {
      success: true,
      data: {
        operation: authority.operation,
        overview: await loadVehicleReidV2OperatorOverview({
          authorityOverview: authority.overview,
        }),
      },
    };
  } catch (error) {
    return vehicleReidV2AuthorityActionFailure(error, "Unable to change the ReID authority mode.");
  }
}

export async function transitionVehicleReidV1Producer(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const authority = await (await getVehicleReidV2AuthorityService()).transitionV1Producer({
      state: input.state,
      confirmation: input.confirmation,
      reason: input.reason,
      actor: principal,
    });
    revalidatePath("/settings/vehicle-intelligence/processing");
    revalidatePath("/visual_search");
    revalidatePath("/visual_search/vehicles");
    revalidatePath("/visual_search/review");
    wakeVisualIndexWorker();
    return {
      success: true,
      data: {
        operation: authority.operation,
        overview: await loadVehicleReidV2OperatorOverview({
          authorityOverview: authority.overview,
        }),
      },
    };
  } catch (error) {
    return vehicleReidV2AuthorityActionFailure(
      error,
      "Unable to change the retained ReID v1 producer state."
    );
  }
}

export async function getVehicleReidProfiles(input = {}) {
  await requirePermission("plate.read");
  try {
    const data = await (await getVehicleReidV2AuthorityService()).listProfiles(input);
    return { success: true, data };
  } catch (error) {
    return vehicleReidV2AuthorityActionFailure(error, "Unable to load ReID profiles.");
  }
}

export async function getVehicleReidProfile(profileId) {
  await requirePermission("plate.read");
  try {
    const data = await (await getVehicleReidV2AuthorityService()).getProfile(profileId);
    return data
      ? { success: true, data }
      : { success: false, error: "ReID profile not found." };
  } catch (error) {
    return vehicleReidV2AuthorityActionFailure(error, "Unable to load this ReID profile.");
  }
}

export async function resolveVehicleReidRead(readId) {
  await requirePermission("plate.read");
  try {
    const data = await (await getVehicleReidV2AuthorityService()).resolveRead(readId);
    return data
      ? { success: true, data }
      : { success: false, error: "Plate read not found." };
  } catch (error) {
    return vehicleReidV2AuthorityActionFailure(error, "Unable to resolve this read through ReID.");
  }
}

function vehicleEventShadowCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function vehicleEventShadowOverviewData(overview, worker) {
  const counts = overview?.counts || {};
  return {
    control: {
      enabled: overview?.control?.enabled === true,
      settleSeconds: vehicleEventShadowCount(overview?.control?.settleSeconds),
      batchSize: vehicleEventShadowCount(overview?.control?.batchSize),
      enabledAt: overview?.control?.enabledAt || null,
      disabledAt: overview?.control?.disabledAt || null,
    },
    counts: {
      eligibleObservations: vehicleEventShadowCount(counts.eligible_observations),
      unpairedObservations: vehicleEventShadowCount(counts.unpaired_observations),
      activeEvents: vehicleEventShadowCount(counts.active_events),
      retiredEvents: vehicleEventShadowCount(counts.retired_events),
      sharedAssetEvents: vehicleEventShadowCount(counts.shared_asset_events),
      timedPairEvents: vehicleEventShadowCount(counts.timed_pair_events),
      correlatedReads: vehicleEventShadowCount(counts.correlated_reads),
      rejectedDecisions: vehicleEventShadowCount(counts.rejected_decisions),
      lastEventAt: counts.last_event_at || null,
    },
    recentDecisions: (overview?.recentDecisions || []).map((item) => ({
      id: Number(item.id),
      outcome: item.outcome || "rejected",
      reason: item.reason || "UNKNOWN",
      overviewContext: item.overview_context || null,
      anchorReadId: Number(item.anchor_read_id),
      companionReadId: item.companion_read_id == null
        ? null
        : Number(item.companion_read_id),
      candidateCount: vehicleEventShadowCount(item.candidate_count),
      correlationClass: item.correlation_class || null,
      createdAt: item.created_at || null,
    })),
    worker: worker || {
      running: false,
      startedAt: null,
      lastBatch: null,
      lastError: null,
    },
  };
}

function vehicleEventShadowActionFailure(error, fallback) {
  const message = String(error?.message || "").trim();
  if (/^(Complete the canonical Overview catalog|Shadow vehicle event)/.test(message)) {
    return { success: false, error: message };
  }
  console.error(fallback, { code: String(error?.code || "") });
  return { success: false, error: fallback };
}

async function loadVehicleEventShadowOverview(runtime) {
  return vehicleEventShadowOverviewData(
    await runtime.service.getOverview(),
    getVehicleEventShadowWorkerStatus()
  );
}

export async function getVehicleEventShadowOverview() {
  await requirePermission("system.manage_settings");
  try {
    const runtime = await getVehicleEventShadowRuntime();
    return { success: true, data: { overview: await loadVehicleEventShadowOverview(runtime) } };
  } catch (error) {
    return vehicleEventShadowActionFailure(error, "Unable to load shadow vehicle events.");
  }
}

export async function setVehicleEventShadowEnabled(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleEventShadowRuntime();
    await runtime.service.setEnabled({
      enabled: input.enabled === true,
      actorUserId: principal.id,
    });
    if (input.enabled === true) wakeVehicleEventShadowWorker();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return { success: true, data: { overview: await loadVehicleEventShadowOverview(runtime) } };
  } catch (error) {
    return vehicleEventShadowActionFailure(
      error,
      "Unable to update shadow vehicle event correlation."
    );
  }
}

export async function runVehicleEventShadowBatch() {
  await requirePermission("maintenance.manage");
  try {
    const runtime = await getVehicleEventShadowRuntime();
    const result = await runtime.service.processBatch();
    revalidatePath("/settings/vehicle-intelligence/processing");
    return {
      success: true,
      data: {
        result,
        overview: await loadVehicleEventShadowOverview(runtime),
      },
    };
  } catch (error) {
    return vehicleEventShadowActionFailure(error, "Unable to run the shadow event batch.");
  }
}

export async function getVehicleDirectionSetup(cameraName = null, options = {}) {
  await requirePermission("system.manage_settings");
  try {
    return {
      success: true,
      data: await (await getCaptureAssetService()).getDirectionSetup(cameraName, {
        includeBackfill: options?.includeBackfill !== false,
        includeCaptures: options?.includeCaptures !== false,
        includeBlueIrisTriggerDirection: options?.includeBlueIrisTriggerDirection !== false,
      }),
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to load vehicle direction setup.");
  }
}

export async function saveVehicleDirectionProfile(input = {}) {
  const principal = await requirePermission("system.manage_settings");
  try {
    const data = await (await getCaptureAssetService()).saveDirectionProfile(input, principal);
    revalidatePath("/settings/vehicle-intelligence");
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to save this camera direction profile.");
  }
}

export async function labelVehicleOrientation(input = {}) {
  const principal = await requirePermission("system.manage_settings");
  try {
    const data = await (await getCaptureAssetService()).recordOrientationLabel({
      readId: input.readId,
      orientation: input.orientation,
      actor: principal,
    });
    revalidatePath("/settings/vehicle-intelligence");
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to save this front/rear example.");
  }
}

export async function reviewVehicleDirection(input = {}) {
  const principal = await requirePermission("plate.review");
  try {
    const data = await (await getCaptureAssetService()).recordOrientationLabel({
      readId: input.readId,
      orientation: input.orientation,
      actor: principal,
    });
    revalidatePath("/live_feed");
    revalidatePath("/visual_search/vehicles");
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to correct this vehicle direction.");
  }
}

export async function runVehicleDirectionBackfillBatch(batchSize = 20) {
  await requirePermission("maintenance.manage");
  try {
    const data = await (await getCaptureAssetService()).backfillDirectionBatch({
      limit: batchSize,
    });
    revalidatePath("/settings/vehicle-intelligence");
    revalidatePath("/live_feed");
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to process historical vehicle directions.");
  }
}

export async function previewVehicleDirectionReevaluation(input = {}) {
  await requirePermission("maintenance.manage");
  try {
    const data = await (await getCaptureAssetService()).previewDirectionReevaluation({
      cameraName: input.cameraName || null,
    });
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to preview historical direction re-evaluation.");
  }
}

export async function queueVehicleDirectionReevaluation(input = {}) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const service = await getCaptureAssetService();
    const data = await service.queueDirectionReevaluation({
      cameraName: input.cameraName || null,
      actor: principal,
    });
    const initialBatch = data.queued > 0
      ? await service.backfillDirectionBatch({ limit: 20 })
      : null;
    revalidatePath("/settings/vehicle-intelligence");
    revalidatePath("/live_feed");
    return { success: true, data: { ...data, initialBatch } };
  } catch (error) {
    return visualSearchFailure(error, "Unable to queue historical direction re-evaluation.");
  }
}

export async function setVehicleDirectionReevaluationPaused(paused) {
  const principal = await requirePermission("maintenance.manage");
  try {
    const service = await getCaptureAssetService();
    const control = await service.setDirectionReevaluationPaused({
      paused: paused === true,
      actor: principal,
    });
    const status = await service.getDirectionSetup();
    revalidatePath("/settings/vehicle-intelligence");
    return { success: true, data: { control, backfill: status.backfill } };
  } catch (error) {
    return visualSearchFailure(error, "Unable to update historical direction re-evaluation.");
  }
}

export async function getVehicleClusterOverview(options = {}) {
  const principal = await requirePermission("plate.read");
  try {
    const canManageSettings = hasPermission(principal, "system.manage_settings");
    const scopedOptions = options?.view === "review"
      && options?.reviewQueue === "setup"
      && !canManageSettings
      ? { ...options, reviewQueue: "vehicle" }
      : options;
    return {
      success: true,
      data: {
        ...(await (await getCaptureAssetService()).getVehicleClusterOverview(scopedOptions)),
        canReview: hasPermission(principal, "plate.review"),
        canAnalyze: hasPermission(principal, "maintenance.manage"),
        canManageSettings,
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to load shadow vehicle clusters.");
  }
}

export async function getVehicleReidV2Shadow(input = {}) {
  const principal = await requirePermission("plate.read");
  try {
    return {
      success: true,
      data: {
        ...(await (await getVehicleReidV2ShadowService()).getOverview(input)),
        canReview: hasPermission(principal, "plate.review"),
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to load ReID v2 shadow comparisons.");
  }
}

export async function submitVehicleReidV2PairReview(input = {}) {
  const principal = await requirePermission("plate.review");
  try {
    const data = await (await getVehicleReidV2ShadowService()).recordPairReview({
      sourceDerivativeId: input.sourceDerivativeId,
      candidateDerivativeId: input.candidateDerivativeId,
      label: input.label,
      actor: principal,
      campaignId: input.campaignId,
    });
    let authorityMerge = null;
    if (data?.review?.id) {
      try {
        authorityMerge = await (await getVehicleReidV2AuthorityService()).mergeProfilesByReview({
          reviewId: data.review.id,
          actor: principal,
        });
      } catch (mergeError) {
        authorityMerge = {
          merged: false,
          reason: String(mergeError?.constraint || mergeError?.code || "merge_rejected"),
        };
      }
    }
    revalidatePath("/visual_search/reid-v2");
    revalidatePath("/visual_search/review");
    revalidatePath("/visual_search");
    revalidatePath("/visual_search/profiles");
    revalidatePath("/live_feed");
    revalidatePath("/database");
    return { success: true, data: { ...data, authorityMerge } };
  } catch (error) {
    return visualSearchFailure(error, "Unable to save this ReID v2 pair review.");
  }
}

export async function startVehicleReidV2ReviewCampaign() {
  const principal = await requirePermission("plate.review");
  try {
    const data = await (await getVehicleReidV2ShadowService()).startReviewCampaign({
      actor: principal,
      targetHumanReviews: 500,
    });
    revalidatePath("/visual_search/reid-v2");
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to start the ReID v2 review campaign.");
  }
}

export async function createVehicleReidV2ProfileCandidateSnapshot() {
  const principal = await requirePermission("plate.review");
  try {
    const data = await (await getVehicleReidV2ShadowService())
      .createProfileCandidateSnapshot({ actor: principal });
    revalidatePath("/visual_search/reid-v2");
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(
      error,
      "Unable to create the ReID v2 shadow profile candidate snapshot."
    );
  }
}

export async function getVehicleProfile(clusterId) {
  const principal = await requirePermission("plate.read");
  try {
    const profile = await (await getCaptureAssetService()).getVehicleProfile(clusterId);
    if (!profile) return { success: false, error: "Vehicle profile was not found." };
    return {
      success: true,
      data: {
        ...profile,
        canReview: hasPermission(principal, "plate.review"),
      },
    };
  } catch (error) {
    return visualSearchFailure(error, "Unable to load this vehicle profile.");
  }
}

export async function analyzeRecentVehicleClusters(limit = 100) {
  await requirePermission("maintenance.manage");
  try {
    const data = await (await getCaptureAssetService()).clusterRecentUnassigned(limit);
    revalidatePath("/visual_search/vehicles");
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to analyze recent vehicle captures.");
  }
}

export async function reviewVehicleClusterSuggestion(input = {}) {
  const principal = await requirePermission("plate.review");
  try {
    const data = await (await getCaptureAssetService()).reviewVehicleCluster({
      readId: input.readId,
      decision: input.decision,
      actor: principal,
    });
    revalidatePath("/visual_search/vehicles");
    revalidatePath("/live_feed");
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to review this vehicle suggestion.");
  }
}

export async function reviewVehiclePlateAssociation(input = {}) {
  const principal = await requirePermission("plate.review");
  try {
    const data = await (await getCaptureAssetService()).reviewVehiclePlateAssociation({
      clusterId: input.clusterId,
      plateNumber: input.plateNumber,
      decision: input.decision,
      actor: principal,
    });
    revalidatePath("/visual_search/vehicles");
    revalidatePath(`/visual_search/vehicles/${Number(input.clusterId)}`);
    revalidatePath("/live_feed");
    return { success: true, data };
  } catch (error) {
    return visualSearchFailure(error, "Unable to review this vehicle plate association.");
  }
}
