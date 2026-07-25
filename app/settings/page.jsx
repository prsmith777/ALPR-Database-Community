import SettingsForm from "./SettingsForm";
import {
  getCurrentAccess,
  getIdentityAdminState,
  getSettings,
} from "@/app/actions";
import { getAuthConfig } from "@/lib/auth";
import { getReleaseInfo } from "@/lib/release-info.mjs";
import { getStorageHealth } from "@/lib/storage-health-runtime.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ADMIN_SECTIONS = new Set([
  "general",
  "database",
  "plateMatching",
  "plateReview",
  "security",
  "privacy",
  "release",
  "blueiris",
  "homeassistant",
]);

export default async function SettingsPage({ searchParams }) {
  const access = await getCurrentAccess();
  const canManageSettings = access.permissions.includes("system.manage_settings");
  const canManageUsers = access.permissions.includes("system.manage_users");
  const personalIdentityState = {
    bootstrapped: access.currentUser.authMode === "named",
    users: [],
    currentUser: access.currentUser,
    canManageUsers: false,
  };
  const [settings, authConfig, identityState, storageHealth] = await Promise.all([
    canManageSettings ? getSettings() : Promise.resolve(null),
    canManageSettings ? getAuthConfig() : Promise.resolve({ apiKey: "" }),
    canManageUsers
      ? getIdentityAdminState()
      : Promise.resolve(personalIdentityState),
    canManageSettings ? getStorageHealth() : Promise.resolve(null),
  ]);

  if (canManageSettings && !settings) {
    throw new Error("Failed to load settings");
  }

  const requestedSection = String((await searchParams)?.section || "");
  const initialSection = canManageSettings && ADMIN_SECTIONS.has(requestedSection)
    ? requestedSection
    : canManageSettings ? "general" : "security";

  return (
    <SettingsForm
      initialSettings={settings}
      initialApiKey={authConfig.apiKey || ""}
      initialIdentityState={identityState}
      initialStorageHealth={storageHealth}
      initialReleaseInfo={getReleaseInfo()}
      canManageSettings={canManageSettings}
      initialSection={initialSection}
    />
  );
}
