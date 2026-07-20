import SettingsForm from "./SettingsForm";
import {
  getCurrentAccess,
  getIdentityAdminState,
  getSettings,
} from "@/app/actions";
import { getAuthConfig } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SettingsPage() {
  const access = await getCurrentAccess();
  const canManageSettings = access.permissions.includes("system.manage_settings");
  const [settings, authConfig, identityState] = await Promise.all([
    canManageSettings ? getSettings() : Promise.resolve(null),
    canManageSettings ? getAuthConfig() : Promise.resolve({ apiKey: "" }),
    getIdentityAdminState(),
  ]);

  if (canManageSettings && !settings) {
    throw new Error("Failed to load settings");
  }

  return (
    <SettingsForm
      initialSettings={settings}
      initialApiKey={authConfig.apiKey || ""}
      initialIdentityState={identityState}
      canManageSettings={canManageSettings}
    />
  );
}
