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
  updateNotificationPriorityDB,
  getTagsForPlate,
  correctAllPlateReads,
  getDistinctCameraNames,
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
  rollbackNotificationRule,
} from "@/lib/notification-cutover-runtime.mjs";
import {
  simulateNotificationRuleDraft,
  updateNotificationRuleDraft,
} from "@/lib/notification-rule-draft-runtime.mjs";
import { getCaptureAssetService } from "@/lib/capture-asset-runtime.mjs";
import {
  getVisualIndexRuntimeStatus,
  wakeVisualIndexWorker,
} from "@/lib/visual-index-runtime.mjs";
import {
  applyVisualIndexPace,
  normalizeVisualIndexSettings,
  visualIndexPace,
} from "@/lib/visual-index-settings.mjs";
import {
  getNotificationPlates as getNotificationPlatesDB,
  addNotificationPlate as addNotificationPlateDB,
  toggleNotification as toggleNotificationDB,
  deleteNotification as deleteNotificationDB,
} from "@/lib/db";

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
import path from "path";
import fs from "fs/promises";
import split2 from "split2";
import fileStorage from "@/lib/fileStorage";

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
  if (!hasPermission(principal, permission)) {
    throw new Error("Permission denied");
  }
  return principal;
}


function plateReviewActionFailure(error, fallback) {
  const safeCodes = new Set([
    "ALIAS_EXISTS",
    "ALIAS_NOT_FOUND",
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
  cameraName
) {
  await requirePermission("plate.read");
  console.log("Fetching dashboard metrics");
  try {
    const metrics = await getMetrics(startDate, endDate, cameraName);

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
    const tagStats = metrics.tag_stats || [];
    const totalTaggedPlates = tagStats.reduce((sum, tag) => sum + tag.count, 0);

    // Process camera stats
    const cameraData = metrics.camera_counts || [];

    return {
      ...metrics,
      time_distribution: timeDistribution,
      camera_counts: cameraData,
      tag_stats: tagStats.map((tag) => ({
        ...tag,
        percentage: ((tag.count / totalTaggedPlates) * 100).toFixed(1),
      })),
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
      top_plates: [],
      tag_stats: [],
    };
  }
}

export async function deleteTagFromPlate(formData) {
  await requirePermission("tag.manage");
  console.log("Deleting tag from plate");
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
  console.log("Deleting known plate");
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
  console.log("Deleting plate from database");
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
  console.log("Deleting plate recognition");
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
  console.log("Fetching known plates");
  try {
    console.log("known plates action run");
    return { success: true, data: await getKnownPlates() };
  } catch (error) {
    console.error("Error getting known plates:", error);
    return { success: false, error: "Failed to get known plates" };
  }
}

export async function getTags() {
  await requirePermission("plate.read");
  console.log("Fetching tags");
  try {
    return { success: true, data: await getAvailableTags() };
  } catch (error) {
    console.error("Error getting tags:", error);
    return { success: false, error: "Failed to get tags" };
  }
}

export async function addTag(formData) {
  await requirePermission("tag.manage");
  console.log("Adding tag");
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
  console.log("Updating tag");
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
  console.log("Deleting tag");
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
  console.log("Adding known plate");
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
  console.log("Adding tag to plate");
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
  console.log("Removing tag from plate");
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
  console.log("Fetching plate history");
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
  console.log("Querying plate database");
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
  search = "",
  fuzzySearch = false,
  matchMode = "balanced",
  tag = "all",
  tags = [],
  dateRange = null,
  hourRange = null,
  cameraName = "",
  cameraNames = [],
  sortField = "",
  sortDirection = "",
} = {}) {
  await requirePermission("plate.read");
  console.log("Fetching latest plate reads");
  try {
    const config = await getConfig();
    const result = await getPlateReads({
      page,
      pageSize,
      filters: {
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
        hourRange,
        cameraNames:
          Array.isArray(cameraNames) && cameraNames.length > 0
            ? cameraNames
            : cameraName
              ? [cameraName]
              : [],
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
  console.log("Fetching plate insights");
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
  console.log("Toggling plate flag");
  try {
    const plateNumber = formData.get("plateNumber");
    const flagged = formData.get("flagged") === "true";

    const result = await togglePlateFlag(plateNumber, flagged);

    revalidatePath("/flagged");
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
  console.log("Fetching flagged plates");
  try {
    const plates = await getFlaggedPlates();
    return plates;
  } catch (error) {
    console.error("Error fetching flagged plates:", error);
    return [];
  }
}

export async function getNotificationPlates() {
  await requirePermission("plate.read");
  console.log("Checking notification plates");
  try {
    const plates = await getNotificationPlatesDB();
    return { success: true, data: plates };
  } catch (error) {
    console.error("Error in getNotificationPlates action:", error);
    return { success: false, error: "Failed to fetch notification plates" };
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

export async function addNotificationPlate(formData) {
  await requirePermission("notification.manage");
  console.log("Adding notification plate");
  const plateNumber = formData.get("plateNumber");
  const result = await addNotificationPlateDB(plateNumber);
  revalidatePath("/notifications");
  return result;
}

export async function toggleNotification(formData) {
  await requirePermission("notification.manage");
  console.log("Toggling notification");
  const plateNumber = formData.get("plateNumber");
  const enabled = formData.get("enabled") === "true";
  const result = await toggleNotificationDB(plateNumber, enabled);
  revalidatePath("/notifications");
  return result;
}

export async function deleteNotification(formData) {
  await requirePermission("notification.manage");
  console.log("Deleting notification");
  try {
    const plateNumber = formData.get("plateNumber");
    console.log("Server action received plateNumber:", plateNumber);
    await deleteNotificationDB(plateNumber);
    revalidatePath("/notifications");
    return { success: true };
  } catch (error) {
    console.error("Error deleting notification:", error);
    return { success: false, error: "Failed to delete notification" };
  }
}

export async function updateNotificationPriority(formData) {
  await requirePermission("notification.manage");
  console.log("Updating notification priority");
  try {
    // When using Select component, the values come directly as arguments
    // not as FormData
    const plateNumber = formData.plateNumber;
    const priority = parseInt(formData.priority);

    if (isNaN(priority) || priority < -2 || priority > 2) {
      return { success: false, error: "Invalid priority value" };
    }

    const result = await updateNotificationPriorityDB(plateNumber, priority);
    if (!result) {
      return { success: false, error: "Notification not found" };
    }
    return { success: true, data: result };
  } catch (error) {
    console.error("Error updating notification priority:", error);
    return { success: false, error: "Failed to update notification priority" };
  }
}


export async function loginAction(formData) {
  console.log("Attempting login...");
  const username = String(formData.get("username") || "").trim();
  const password = formData.get("password");

  if (!password) {
    return { error: "Password is required" };
  }

  try {
    const headersList = await headers();
    const userAgent = headersList.get("user-agent") || "Unknown Device";

    if (username) {
      const namedLogin = await getIdentityService().authenticate({
        username,
        password,
        userAgent,
      });
      if (!namedLogin) return { error: "Invalid username or password" };

      const cookieStore = await cookies();
      setSessionCookie(cookieStore, namedLogin.sessionToken);
      return { success: true };
    }

    const config = await getAuthConfig(); // Get current config to check hash type
    const storedHash = config.password;

    const isPasswordValid = await verifyPassword(password); // This verifies against whatever hash type is stored

    if (!isPasswordValid) {
      console.log("Invalid password attempt");
      return { error: "Invalid username or password" };
    }

    // --- Password Migration Logic ---
    // If the stored password is an old SHA256 hash (doesn't start with '$2'),
    // re-hash the provided plaintext password to bcrypt and save it.
    if (!storedHash.startsWith("$2")) {
      console.log("Old SHA256 password verified. Migrating to bcrypt...");
      const newBcryptHash = await hashPasswordBcrypt(password);
      config.password = newBcryptHash;
      await updateAuthConfig(config); // Save the updated config with the new hash
      console.log("Password successfully migrated to bcrypt.");
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
  return {
    currentUser: {
      id: principal.id,
      username: principal.username,
      displayName: principal.displayName,
      roles: principal.roles,
      authMode: principal.authMode,
      mustChangePassword: Boolean(principal.mustChangePassword),
    },
    permissions: [...(principal.permissions || [])],
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

    if (updateIfExists("haEnabled") || updateIfExists("haWhitelist")) {
      newConfig.homeassistant = {
        ...currentConfig.homeassistant,
        enabled: formData.get("haEnabled") === "true",
        whitelist: formData.get("haWhitelist")
          ? JSON.parse(formData.get("haWhitelist"))
          : currentConfig.homeassistant?.whitelist || [],
      };
    }
    if (updateIfExists("bihost")) {
      newConfig.blueiris = {
        ...currentConfig.blueiris,
        host: formData.get("bihost"),
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

export async function correctPlateRead(formData) {
  const principal = await requirePermission("plate.review");
  try {
    const readId = formData.get("readId");
    const oldPlateNumber = formData.get("oldPlateNumber");
    const newPlateNumber = formData.get("newPlateNumber");
    const correctAll = formData.get("correctAll") === "true";
    const rememberAlias = formData.get("rememberAlias") === "true";
    const cameraName =
      formData.get("aliasScope") === "camera"
        ? formData.get("cameraName")
        : null;
    const reason = formData.get("reason");
    const notes = formData.get("notes");
    const repository = getPlateReviewRepository();

    if (correctAll && !hasPermission(principal, "plate.review.batch")) {
      return { success: false, error: "Administrator permission is required for batch correction." };
    }
    if (rememberAlias && !hasPermission(principal, "plate.alias.manage")) {
      return { success: false, error: "Administrator permission is required to create a recurring alias." };
    }

    const data = correctAll
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
    let warning = null;
    if (rememberAlias) {
      try {
        alias = await repository.createAlias({
          sourcePlate: formData.get("aliasSourcePlate") || oldPlateNumber,
          targetPlate: newPlateNumber,
          cameraName,
          reason,
          actor: principal,
        });
      } catch (error) {
        warning = error?.message || "The read was corrected, but the recurring alias could not be created.";
      }
    }

    revalidatePath("/live_feed");
    revalidatePath("/database");
    return { success: true, data, alias, warning };
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
    const data = await getPlateReviewRepository().reverseLatestReview({
      readId: formData.get("readId"),
      reason: formData.get("reason"),
      actor: principal,
    });
    revalidatePath("/live_feed");
    revalidatePath("/database");
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
    console.log("🔴 Starting revalidation");
    revalidatePath("/live_feed");
    console.log("🔴 Revalidation completed");
  } catch (error) {
    console.error("🔴 Revalidation failed:", error);
    throw error;
  }
}

export async function fetchPlateImagePreviews(plateNumber, timeFrame) {
  await requirePermission("plate.read");
  const endDate = new Date();
  const startDate = new Date();

  switch (timeFrame) {
    case "3d":
      startDate.setDate(endDate.getDate() - 3);
      break;
    case "7d":
      startDate.setDate(endDate.getDate() - 7);
      break;
    case "30d":
      startDate.setDate(endDate.getDate() - 30);
      break;
    case "all":
      startDate.setFullYear(2000);
      break;
    default: // 24h
      startDate.setDate(endDate.getDate() - 1);
  }

  return await getPlateImagePreviews(plateNumber, startDate, endDate);
}

export async function getSystemLogs() {
  await requirePermission("system.view_audit");
  try {
    const logFile = path.join(process.cwd(), "logs", "app.log");
    const content = await fs.readFile(logFile, "utf8");

    return {
      success: true,
      data: content
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            // Try parsing as Winston JSON format
            const parsed = JSON.parse(line);
            return {
              timestamp: parsed.timestamp,
              level: parsed.level.toUpperCase(),
              // Strip ANSI color codes
              message: parsed.message.replace(/\u001b\[\d+m/g, ""),
            };
          } catch (e) {
            // Fall back to old format if it's not JSON
            const [timestamp, rest] = line.split(" [");
            const [level, ...messageParts] = rest.split("] ");
            return {
              timestamp,
              level,
              message: messageParts.join("] "),
            };
          }
        }),
    };
  } catch (error) {
    console.error("Error reading logs:", error);
    return { success: false, error: "Failed to read system logs" };
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

export async function addDBPlate(plate_number, flagged = false) {
  await requirePermission("plate.review");
  try {
    await addUnseenPlate(plate_number, flagged);
    revalidatePath("/flagged");
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
  ]);
  if (safeCodes.has(error?.code)) return { success: false, error: error.message };
  console.error(fallback, { code: String(error?.code || "") });
  return { success: false, error: fallback };
}

export async function getVisualSearchBootstrap() {
  const principal = await requirePermission("plate.read");
  try {
    const canManageIndex = hasPermission(principal, "maintenance.manage");
    const [data, config] = await Promise.all([
      (await getCaptureAssetService()).getBootstrap({
        includeCameraSetup: canManageIndex,
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
