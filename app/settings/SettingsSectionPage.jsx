import { redirect } from "next/navigation";

import SettingsForm from "./SettingsForm";
import {
  getCurrentAccess,
  getIdentityAdminState,
  getSettings,
} from "@/app/actions";
import { getAuthConfig } from "@/lib/auth";
import { getReleaseInfo } from "@/lib/release-info.mjs";
import { getStorageMaintenanceOverview } from "@/lib/storage-maintenance-service.mjs";

const ADMIN_SECTIONS = new Set([
  "general",
  "database",
  "plateMatching",
  "plateReview",
  "privacy",
  "release",
  "blueiris",
  "homeassistant",
]);

export default async function SettingsSectionPage({ sectionId }) {
  const access = await getCurrentAccess();
  const mustChangePassword = access.currentUser.mustChangePassword === true;
  if (mustChangePassword && sectionId !== "security") {
    redirect("/settings/security");
  }
  const canManageSettings =
    !mustChangePassword && access.permissions.includes("system.manage_settings");
  const canManageUsers =
    !mustChangePassword && access.permissions.includes("system.manage_users");
  const canManageMaintenance =
    !mustChangePassword && access.permissions.includes("maintenance.manage");
  const canApproveAutomaticCleanup =
    !mustChangePassword && access.permissions.includes("maintenance.automatic_cleanup.approve");
  if (!canManageSettings && ADMIN_SECTIONS.has(sectionId)) {
    redirect("/settings/security");
  }

  const personalIdentityState = {
    bootstrapped: access.currentUser.authMode === "named",
    users: [],
    currentUser: access.currentUser,
    canManageUsers: false,
  };
  const [settings, authConfig, identityState, storageMaintenance] = await Promise.all([
    canManageSettings ? getSettings() : Promise.resolve(null),
    canManageSettings ? getAuthConfig() : Promise.resolve({ apiKey: "" }),
    canManageUsers
      ? getIdentityAdminState()
      : Promise.resolve(personalIdentityState),
    canManageSettings ? getStorageMaintenanceOverview() : Promise.resolve(null),
  ]);

  if (canManageSettings && !settings) {
    throw new Error("Failed to load settings");
  }

  return (
    <SettingsForm
      initialSettings={settings}
      initialApiKey={authConfig.apiKey || ""}
      initialIdentityState={identityState}
      initialStorageHealth={storageMaintenance?.health || null}
      initialStorageMaintenance={storageMaintenance}
      initialReleaseInfo={getReleaseInfo()}
      canManageSettings={canManageSettings}
      canManageMaintenance={canManageMaintenance}
      canApproveAutomaticCleanup={canApproveAutomaticCleanup}
      initialSection={sectionId}
    />
  );
}
