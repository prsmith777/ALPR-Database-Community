import SettingsForm from "./SettingsForm";
import { getIdentityAdminState, getSettings } from "@/app/actions";
import { getAuthConfig } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SettingsPage() {
  const [settings, authConfig, identityState] = await Promise.all([
    getSettings(),
    getAuthConfig(),
    getIdentityAdminState(),
  ]);

  if (!settings) {
    throw new Error("Failed to load settings");
  }

  return (
    <SettingsForm
      initialSettings={settings}
      initialApiKey={authConfig.apiKey}
      initialIdentityState={identityState}
    />
  );
}
