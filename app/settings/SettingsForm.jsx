"use client";

import { useState } from "react";
import { useTransition, useOptimistic } from "react";
import { BellRing, HardDrive, Shield, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { SettingsShell } from "@/components/settings/SettingsShell";
import {
  updateSettings,
  updatePassword,
  regenerateApiKey,
} from "@/app/actions";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRouteTab } from "@/components/useRouteTab";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import ToggleSwitch from "@/components/ui/toggle-switch";
import { SecuritySettings } from "./SecuritySettings";
import PlateMatchingSettings from "./PlateMatchingSettings";
import PlateReviewSettings from "./PlateReviewSettings";
import PushoverUsageCard from "./PushoverUsageCard";
import ReleaseInformationCard from "./ReleaseInformationCard";
import StorageHealthCard from "./StorageHealthCard";
import StorageMaintenancePanel from "./StorageMaintenancePanel";
import BlueIrisConnectionTest from "./BlueIrisConnectionTest";

const DATA_PRIVACY_ROUTES = Object.freeze({
  storage: "/settings/data-privacy",
  monitoring: "/settings/data-privacy/monitoring",
  cleanup: "/settings/data-privacy/cleanup",
  privacy: "/settings/data-privacy/privacy",
});

export default function SettingsForm({
  initialSettings,
  initialApiKey,
  initialIdentityState,
  initialStorageHealth,
  initialStorageMaintenance,
  initialReleaseInfo,
  canManageSettings,
  canManageMaintenance,
  canApproveAutomaticCleanup,
  initialSection,
}) {
  const [isPending, startTransition] = useTransition(); // For general settings
  const [error, setError] = useState(""); // General error for main form
  const [success, setSuccess] = useState(false); // General success for main form
  const activeSection = initialSection || (canManageSettings ? "general" : "security");
  const privacyTab = useRouteTab(DATA_PRIVACY_ROUTES, "storage");
  const [showApiKey, setShowApiKey] = useState(false); // This is local state for general form (will be managed by SecuritySettings itself now)
  const [showDialog, setShowDialog] = useState(false); // This is local state for general form (will be managed by SecuritySettings itself now)

  // `handlePasswordSubmit` and `handleRegenerateApiKey` in THIS component (`SettingsForm`)
  // are the ones directly attached to the form in the `renderSecuritySection` function
  // of the original code you provided.
  // We need to keep these handlers exactly as they were, but ensure they call the
  // `updatePassword` and `regenerateApiKey` server actions correctly.

  const handleSettingsSubmit = async (formData) => {
    setError("");
    setSuccess(false);

    // Only include the fields from the current section in the form data
    const newFormData = new FormData();

    switch (activeSection) {
      case "general":
        newFormData.append("maxRecords", formData.get("maxRecords"));
        newFormData.append("retention", formData.get("retention"));
        newFormData.append("ignoreNonPlate", formData.get("ignoreNonPlate"));
        newFormData.append("timeFormat", Number(formData.get("timeFormat")));
        break;
      case "database":
        newFormData.append("dbHost", formData.get("dbHost"));
        newFormData.append("dbName", formData.get("dbName"));
        newFormData.append("dbUser", formData.get("dbUser"));
        newFormData.append("dbPassword", formData.get("dbPassword"));
        break;
      case "plateMatching":
        newFormData.append("plateMatching", formData.get("plateMatching"));
        break;
      case "push":
        newFormData.append(
          "pushoverEnabled",
          formData.get("pushoverEnabled") === "on"
        );
        newFormData.append(
          "pushoverAppToken",
          formData.get("pushoverAppToken")
        );
        newFormData.append(
          "clearPushoverAppToken",
          formData.get("clearPushoverAppToken") === "on"
        );
        newFormData.append("pushoverUserKey", formData.get("pushoverUserKey"));
        newFormData.append(
          "clearPushoverUserKey",
          formData.get("clearPushoverUserKey") === "on"
        );
        newFormData.append("pushoverTitle", formData.get("pushoverTitle"));
        newFormData.append(
          "pushoverPriority",
          formData.get("pushoverPriority")
        );
        newFormData.append("pushoverSound", formData.get("pushoverSound"));
        newFormData.append("emailEnabled", formData.get("emailEnabled") === "on");
        newFormData.append("emailHost", formData.get("emailHost"));
        newFormData.append("emailPort", formData.get("emailPort"));
        newFormData.append("emailSecure", formData.get("emailSecure") === "on");
        newFormData.append("emailVerifyTls", formData.get("emailVerifyTls") === "on");
        newFormData.append("emailUsername", formData.get("emailUsername"));
        newFormData.append("emailPassword", formData.get("emailPassword"));
        newFormData.append("clearEmailPassword", formData.get("clearEmailPassword") === "on");
        newFormData.append("emailFromAddress", formData.get("emailFromAddress"));
        newFormData.append("emailFromName", formData.get("emailFromName"));
        newFormData.append("webhookEnabled", formData.get("webhookEnabled") === "on");
        newFormData.append("webhookSigningSecret", formData.get("webhookSigningSecret"));
        newFormData.append("clearWebhookSigningSecret", formData.get("clearWebhookSigningSecret") === "on");
        newFormData.append("webhookTimeoutSeconds", formData.get("webhookTimeoutSeconds"));
        newFormData.append("webhookAllowHttp", formData.get("webhookAllowHttp") === "on");
        newFormData.append("webhookAllowPrivateNetworks", formData.get("webhookAllowPrivateNetworks") === "on");
        break;
      case "homeassistant":
        newFormData.append("haEnabled", formData.get("haEnabled") === "on");
        if (formData.get("haWhitelist")) {
          newFormData.append("haWhitelist", formData.get("haWhitelist"));
        }
        break;
      case "blueiris":
        newFormData.append("bihost", formData.get("bihost"));
        newFormData.append("biUsername", formData.get("biUsername"));
        newFormData.append("biPassword", formData.get("biPassword"));
        newFormData.append(
          "clearBiPassword",
          formData.get("clearBiPassword") === "on"
        );
        newFormData.append("biTimeoutSeconds", formData.get("biTimeoutSeconds"));
        break;
    }

    startTransition(async () => {
      const result = await updateSettings(newFormData);
      if (result.success) {
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      } else {
        setError(result.error);
      }
    });
  };

  const handlePasswordSubmit = async (event) => {
    // This handler is local to SettingsForm.jsx
    event.preventDefault(); // Prevent default form submission
    setError(""); // Use parent's error state
    setSuccess(false); // Use parent's success state

    const formData = new FormData(event.target); // Correctly create FormData from event.target

    if (formData.get("newPassword") !== formData.get("confirmPassword")) {
      setError("Passwords do not match"); // Set parent's error state
      return;
    }

    // Use the main `startTransition` from `SettingsForm` for password changes.
    // This implies `isPending` will cover both general settings and security.
    // If you need separate loading states, you would add a new `useTransition` here.
    startTransition(async () => {
      // <--- CRUCIAL FIX: Pass the entire formData object
      const result = await updatePassword(formData);
      if (result.success) {
        setSuccess(true); // Set parent's success state
        event.target.reset(); // Reset the form in SecuritySettings via this event
      } else {
        setError(result.error); // Set parent's error state
      }
    });
  };

  const handleRegenerateApiKey = async () => {
    // This handler is local to SettingsForm.jsx
    setError(""); // Use parent's error state
    setSuccess(false); // Use parent's success state

    // Use the main `startTransition` from `SettingsForm` for API key regeneration.
    startTransition(async () => {
      const result = await regenerateApiKey();
      if (result.success) {
        setShowDialog(false); // This local state needs to be managed for this dialog
        setSuccess(true); // Set parent's success state
        // The SecuritySettings component would need to receive the new API key
        // to update its display. This means initialApiKey should be `currentApiKey`
        // and updated here. See renderSecuritySection below.
      } else {
        setError(result.error); // Set parent's error state
      }
    });
  };

  // State to manage API key display in SecuritySettings, updated by regenerateApiKey
  const [currentApiKeyInForm, setCurrentApiKeyInForm] = useState(initialApiKey);

  // When API key is regenerated in handleRegenerateApiKey:
  // - result.apiKey should be set to currentApiKeyInForm
  // - setShowDialog(false) to close the dialog

  // Re-write handleRegenerateApiKey to update currentApiKeyInForm
  const handleRegenerateApiKeyInSettingsForm = async () => {
    setError("");
    setSuccess(false); // Clear general success
    const dialogWasOpen = showDialog; // Capture dialog state before action

    startTransition(async () => {
      try {
        const result = await regenerateApiKey();
        if (result.success) {
          setCurrentApiKeyInForm(result.apiKey); // Update state for SecuritySettings
          if (dialogWasOpen) setShowDialog(false); // Close dialog if it was open
          setSuccess(true); // Set general success
          setTimeout(() => setSuccess(false), 3000); // Clear after 3 seconds
        } else {
          setError(result.error); // Set general error
        }
      } catch (e) {
        setError("An unexpected error occurred during API key regeneration.");
        console.error("API key regeneration client-side error:", e);
      }
    });
  };

  const renderGeneralSection = () => (
    <div key="general-section" className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground mb-2">
          General Settings
        </h2>
        <p className="text-muted-foreground">
          Configure basic application settings and preferences.
        </p>
      </div>
      <div className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="maxRecords" className="text-sm font-medium">
            Maximum number of records to keep in live feed
          </Label>
          <p className="text-xs text-muted-foreground mb-2">
            100k records = &lt;100 MB
          </p>
          <Input
            id="maxRecords"
            name="maxRecords"
            type="number"
            defaultValue={initialSettings.general.maxRecords}
            autoComplete="off"
            className="max-w-xs"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="retention" className="text-sm font-medium">
            Image Retention Period (Months)
          </Label>
          <Input
            id="retention"
            name="retention"
            type="number"
            defaultValue={initialSettings.general.retention}
            autoComplete="off"
            className="max-w-xs"
          />
        </div>
        <div className="space-y-2 w-fit">
          <Label htmlFor="timeFormat" className="text-sm font-medium">
            Time Format
          </Label>
          <ToggleSwitch
            id="timeFormat"
            options={[
              { value: 12, label: "12h" },
              { value: 24, label: "24h" },
            ]}
            name="timeFormat"
            defaultValue={initialSettings.general.timeFormat}
          />
        </div>
      </div>
    </div>
  );

  const renderDatabaseSection = () => (
    <div key="database-section" className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground mb-2">
          Database Configuration
        </h2>
        <p className="text-muted-foreground">
          Configure your database connection settings.
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-3xl">
        <div className="space-y-2">
          <Label htmlFor="dbHost" className="text-sm font-medium">
            Database Host & Port
          </Label>
          <Input
            id="dbHost"
            name="dbHost"
            defaultValue={initialSettings.database.host}
            placeholder="localhost:5432"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="dbName" className="text-sm font-medium">
            Database Name
          </Label>
          <Input
            id="dbName"
            name="dbName"
            defaultValue={initialSettings.database.name}
            placeholder="alpr_db"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="dbUser" className="text-sm font-medium">
            Database User
          </Label>
          <Input
            id="dbUser"
            name="dbUser"
            defaultValue={initialSettings.database.user}
            placeholder="username"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="dbPassword" className="text-sm font-medium">
              Database Password
            </Label>
            <Badge variant="outline">
              {initialSettings.database.passwordConfigured
                ? "Configured"
                : "Not configured"}
            </Badge>
          </div>
          <PasswordInput
            id="dbPassword"
            name="dbPassword"
            visibilityLabel="database password"
            placeholder="Enter a replacement password"
            autoComplete="new-password"
          />
          <p className="text-xs text-muted-foreground">
            Leave blank to keep the configured password. Saved passwords are never sent to the browser.
          </p>
        </div>
      </div>
    </div>
  );

  const renderPushSection = () => (
    <div key="push-section" className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground mb-2">
          Notification Channels
        </h2>
        <p className="text-muted-foreground">
          Configure credentials and transport safety for Pushover, email, and signed webhooks.
        </p>
      </div>
      <div className="space-y-6">
        <PushoverUsageCard />

        <div className="max-w-4xl px-4 border rounded-lg">
          <div className="flex items-center justify-between py-4">
            <div className="space-y-1">
              <Label htmlFor="pushoverEnabled" className="text-sm font-medium">
                Enable Pushover
              </Label>
              <p className="text-sm text-muted-foreground">
                Receive notifications when plates are detected
              </p>
            </div>
            <Switch
              id="pushoverEnabled"
              name="pushoverEnabled"
              defaultChecked={initialSettings.notifications?.pushover?.enabled}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-4xl ml-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="pushoverAppToken" className="text-sm font-medium">
                Application Token (APP_TOKEN)
              </Label>
              <Badge variant="outline">
                {initialSettings.notifications?.pushover?.appTokenConfigured
                  ? "Configured"
                  : "Not configured"}
              </Badge>
            </div>
            <PasswordInput
              id="pushoverAppToken"
              name="pushoverAppToken"
              visibilityLabel="Pushover application token"
              placeholder="Enter a replacement token"
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
              data-form-type="other"
              {...{ "data-lpignore": "true" }}
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to keep the configured token. Saved tokens are never sent to the browser.
            </p>
            {initialSettings.notifications?.pushover?.appTokenConfigured && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  name="clearPushoverAppToken"
                  className="h-4 w-4 rounded border-input"
                />
                Clear the saved application token
              </label>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="pushoverUserKey" className="text-sm font-medium">
                User Key (USER_KEY)
              </Label>
              <Badge variant="outline">
                {initialSettings.notifications?.pushover?.userKeyConfigured
                  ? "Configured"
                  : "Not configured"}
              </Badge>
            </div>
            <PasswordInput
              id="pushoverUserKey"
              name="pushoverUserKey"
              visibilityLabel="Pushover user key"
              placeholder="Enter a replacement user key"
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
              data-form-type="other"
              {...{ "data-lpignore": "true" }}
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to keep the configured key. Saved keys are never sent to the browser.
            </p>
            {initialSettings.notifications?.pushover?.userKeyConfigured && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  name="clearPushoverUserKey"
                  className="h-4 w-4 rounded border-input"
                />
                Clear the saved user key
              </label>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="pushoverTitle" className="text-sm font-medium">
              Notification Title
            </Label>
            <Input
              id="pushoverTitle"
              name="pushoverTitle"
              defaultValue={initialSettings.notifications?.pushover?.title}
              placeholder="ALPR Alert"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
              data-form-type="other"
              {...{ "data-lpignore": "true" }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pushoverPriority" className="text-sm font-medium">
              Priority (-2 to 2)
            </Label>
            <Input
              id="pushoverPriority"
              name="pushoverPriority"
              type="number"
              min="-2"
              max="2"
              defaultValue={initialSettings.notifications?.pushover?.priority}
              autoComplete="off"
              {...{ "data-lpignore": "true" }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pushoverSound" className="text-sm font-medium">
              Notification Sound
            </Label>
            <Input
              id="pushoverSound"
              name="pushoverSound"
              defaultValue={initialSettings.notifications?.pushover?.sound}
              placeholder="pushover"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
              data-form-type="other"
              {...{ "data-lpignore": "true" }}
            />
          </div>
        </div>

        <div className="max-w-4xl space-y-5 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">Email (SMTP)</h3>
              <p className="text-sm text-muted-foreground">Send rule actions through an authenticated or trusted SMTP relay.</p>
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="emailEnabled">Enable email</Label>
              <Switch id="emailEnabled" name="emailEnabled" defaultChecked={initialSettings.notifications?.email?.enabled} />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2 text-sm"><span className="font-medium">SMTP host</span><Input id="emailHost" name="emailHost" defaultValue={initialSettings.notifications?.email?.host} placeholder="smtp.example.com" autoComplete="off" /></label>
            <label className="space-y-2 text-sm"><span className="font-medium">SMTP port</span><Input id="emailPort" name="emailPort" type="number" min="1" max="65535" defaultValue={initialSettings.notifications?.email?.port ?? 587} /></label>
            <label className="space-y-2 text-sm"><span className="font-medium">Username</span><Input id="emailUsername" name="emailUsername" defaultValue={initialSettings.notifications?.email?.username} autoComplete="off" /></label>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2"><Label htmlFor="emailPassword">Password</Label><Badge variant="outline">{initialSettings.notifications?.email?.passwordConfigured ? "Configured" : "Not configured"}</Badge></div>
              <PasswordInput id="emailPassword" name="emailPassword" visibilityLabel="SMTP password" placeholder="Enter a replacement password" autoComplete="new-password" />
              <p className="text-xs text-muted-foreground">Leave blank to keep the saved password. SMTP can also be used without authentication when both username and password are blank.</p>
              {initialSettings.notifications?.email?.passwordConfigured && <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" name="clearEmailPassword" className="h-4 w-4 rounded border-input" />Clear the saved SMTP password</label>}
            </div>
            <label className="space-y-2 text-sm"><span className="font-medium">From address</span><Input id="emailFromAddress" name="emailFromAddress" type="email" defaultValue={initialSettings.notifications?.email?.from_address} placeholder="alpr@example.com" autoComplete="off" /></label>
            <label className="space-y-2 text-sm"><span className="font-medium">From name</span><Input id="emailFromName" name="emailFromName" defaultValue={initialSettings.notifications?.email?.from_name ?? "ALPR Database"} autoComplete="off" /></label>
          </div>
          <div className="flex flex-wrap gap-6 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="emailSecure" defaultChecked={initialSettings.notifications?.email?.secure} className="h-4 w-4 rounded border-input" />Use implicit TLS (usually port 465)</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="emailVerifyTls" defaultChecked={initialSettings.notifications?.email?.verify_tls !== false} className="h-4 w-4 rounded border-input" />Verify the SMTP TLS certificate</label>
          </div>
        </div>

        <div className="max-w-4xl space-y-5 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">Signed webhooks</h3>
              <p className="text-sm text-muted-foreground">POST JSON with an HMAC-SHA256 signature, event ID, and idempotency key.</p>
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="webhookEnabled">Enable webhooks</Label>
              <Switch id="webhookEnabled" name="webhookEnabled" defaultChecked={initialSettings.notifications?.webhook?.enabled} />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2"><Label htmlFor="webhookSigningSecret">Signing secret</Label><Badge variant="outline">{initialSettings.notifications?.webhook?.signingSecretConfigured ? "Configured" : "Not configured"}</Badge></div>
              <PasswordInput id="webhookSigningSecret" name="webhookSigningSecret" visibilityLabel="webhook signing secret" placeholder="Enter a replacement secret" autoComplete="new-password" />
              <p className="text-xs text-muted-foreground">Receivers verify the raw JSON body using the X-ALPR-Signature header.</p>
              {initialSettings.notifications?.webhook?.signingSecretConfigured && <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" name="clearWebhookSigningSecret" className="h-4 w-4 rounded border-input" />Clear the saved signing secret</label>}
            </div>
            <label className="space-y-2 text-sm"><span className="font-medium">Request timeout (seconds)</span><Input id="webhookTimeoutSeconds" name="webhookTimeoutSeconds" type="number" min="2" max="30" defaultValue={initialSettings.notifications?.webhook?.timeout_seconds ?? 10} /></label>
          </div>
          <div className="space-y-3 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="webhookAllowHttp" defaultChecked={initialSettings.notifications?.webhook?.allow_http} className="h-4 w-4 rounded border-input" />Allow unencrypted HTTP webhook targets</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="webhookAllowPrivateNetworks" defaultChecked={initialSettings.notifications?.webhook?.allow_private_networks} className="h-4 w-4 rounded border-input" />Allow private-network targets (10.x, 172.16–31.x, and 192.168.x)</label>
            <p className="text-xs text-muted-foreground">Loopback, link-local, multicast, URL credentials, redirects, and special-use targets remain blocked even when these options are enabled.</p>
          </div>
        </div>
      </div>
    </div>
  );

  const renderHomeAssistantSection = () => (
    <div key="homeassistant-section" className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground mb-2">
          HomeAssistant iframe Login Bypass
        </h2>
        <p className="text-muted-foreground">
          Configure access for HomeAssistant iframe integration.
        </p>
      </div>
      <div className="space-y-6">
        <div className="max-w-2xl">
          <div className="flex items-center justify-between py-4 border-b">
            <div className="space-y-1">
              <Label htmlFor="haEnabled" className="text-sm font-medium">
                Enable Whitelist
              </Label>
              <p className="text-sm text-muted-foreground">
                Allow specific devices to bypass authentication when accessing
                the app via HomeAssistant iframe.
              </p>
            </div>
            <Switch
              id="haEnabled"
              name="haEnabled"
              defaultChecked={initialSettings.homeassistant?.enabled}
            />
          </div>
        </div>

        {initialSettings.homeassistant?.enabled && (
          <IPWhitelistManager
            initialIPs={initialSettings.homeassistant?.whitelist || []}
            onUpdate={(newIPs) => {
              const formData = new FormData();
              formData.append("haWhitelist", JSON.stringify(newIPs));
              handleSettingsSubmit(formData);
            }}
          />
        )}
      </div>
    </div>
  );

  const renderSecuritySection = () => (
    <div key="security-section" className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground mb-2">
          Security Settings
        </h2>
        <p className="text-muted-foreground">
          Manage your security settings and API keys.
        </p>
      </div>
      <SecuritySettings
        initialApiKey={currentApiKeyInForm} // Pass the dynamically updated API key
        initialIdentityState={initialIdentityState}
        canManageSettings={canManageSettings}
      />
    </div>
  );

  const renderPrivacySection = () => (
    <div key="privacy-section" className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground mb-2">
          Data &amp; Privacy
        </h2>
        <p className="text-muted-foreground">
          Review how this community build handles information leaving the app.
        </p>
      </div>
      <Tabs value={privacyTab.active} onValueChange={privacyTab.navigate} className="max-w-5xl space-y-6">
        <TabsList aria-label="Data and privacy sections" className="grid h-auto w-full grid-cols-2 gap-1 p-1 lg:grid-cols-4">
          <TabsTrigger value="storage" className="gap-2 py-2">
            <HardDrive className="h-4 w-4" aria-hidden="true" />Storage Health
          </TabsTrigger>
          <TabsTrigger value="monitoring" className="gap-2 py-2">
            <BellRing className="h-4 w-4" aria-hidden="true" />Monitoring
          </TabsTrigger>
          <TabsTrigger value="cleanup" className="gap-2 py-2">
            <Trash2 className="h-4 w-4" aria-hidden="true" />Cleanup
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
              {initialStorageMaintenance?.hostMaintenance?.worker?.status === "healthy" ? "Ready" : "Unavailable"}
            </span>
          </TabsTrigger>
          <TabsTrigger value="privacy" className="gap-2 py-2">
            <Shield className="h-4 w-4" aria-hidden="true" />Privacy
          </TabsTrigger>
        </TabsList>

        <TabsContent value="storage" className="mt-0 space-y-4">
          <StorageHealthCard snapshot={initialStorageHealth} view="storage" />
          <StorageMaintenancePanel
            overview={initialStorageMaintenance}
            canManage={canManageMaintenance}
            canApproveAutomaticCleanup={canApproveAutomaticCleanup}
            view="storage"
          />
        </TabsContent>

        <TabsContent value="monitoring" className="mt-0 space-y-4">
          <StorageHealthCard snapshot={initialStorageHealth} view="monitoring" />
          <StorageMaintenancePanel
            overview={initialStorageMaintenance}
            canManage={canManageMaintenance}
            canApproveAutomaticCleanup={canApproveAutomaticCleanup}
            view="monitoring"
          />
        </TabsContent>

        <TabsContent value="cleanup" className="mt-0">
          <StorageMaintenancePanel
            overview={initialStorageMaintenance}
            canManage={canManageMaintenance}
            canApproveAutomaticCleanup={canApproveAutomaticCleanup}
            view="cleanup"
          />
        </TabsContent>

        <TabsContent value="privacy" className="mt-0 space-y-4">
          <div className="rounded-lg border p-5">
            <h3 className="font-semibold">External reporting is disabled</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This build does not send usage telemetry or upload plate images and
              annotations for model training. It also does not contact the former
              upstream project to check for application updates.
            </p>
          </div>
          <div className="rounded-lg border p-5">
            <h3 className="font-semibold">Configured integrations remain explicit</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Pushover, MQTT, Blue Iris, Home Assistant, and AI-agent connections
              communicate only when you configure and use those integrations.
              Local retention planning and storage reconciliation are read-only.
              Automatic deletion remains off until separately activated by an
              Administrator and is limited to reconciliation-confirmed generated
              derived orphans.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );

  const renderReleaseSection = () => (
    <div key="release-section" className="space-y-6">
      <div>
        <h2 className="mb-2 text-2xl font-semibold text-foreground">
          Release information
        </h2>
        <p className="text-muted-foreground">
          Identify the installed application build and review its release notes.
        </p>
      </div>
      <ReleaseInformationCard release={initialReleaseInfo} />
    </div>
  );

  const renderBlueirisSection = () => (
    <div key="blueiris-section" className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground mb-2">
          Blue Iris Configuration
        </h2>
        <p className="text-muted-foreground">
          Configure integration with Blue Iris camera system.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="bihost" className="text-sm font-medium">
            Blue Iris Hostname or IP address
          </Label>
          <p className="text-xs text-muted-foreground mb-2">
            Include :port if not port 80
          </p>
          <Input
            id="bihost"
            name="bihost"
            defaultValue={initialSettings.blueiris.host}
            placeholder="192.168.1.68"
            autoComplete="off"
            className="max-w-lg"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="biUsername">Username</Label>
          <Input
            id="biUsername"
            name="biUsername"
            defaultValue={initialSettings.blueiris.username || ""}
            autoComplete="username"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="biTimeoutSeconds">Request timeout (seconds)</Label>
          <Input
            id="biTimeoutSeconds"
            name="biTimeoutSeconds"
            type="number"
            min="2"
            max="30"
            defaultValue={initialSettings.blueiris.timeout_seconds || 10}
          />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="biPassword">Password</Label>
          <PasswordInput
            id="biPassword"
            name="biPassword"
            autoComplete="new-password"
            placeholder={
              initialSettings.blueiris.passwordConfigured
                ? "Password configured — enter only to replace"
                : "Blue Iris password"
            }
          />
          {initialSettings.blueiris.passwordConfigured && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox id="clearBiPassword" name="clearBiPassword" />
              Clear saved password
            </label>
          )}
        </div>
      </div>
      <BlueIrisConnectionTest />
    </div>
  );

  const renderSection = () => {
    switch (activeSection) {
      case "general":
        return renderGeneralSection();
      case "database":
        return renderDatabaseSection();
      case "plateMatching":
        return (
          <PlateMatchingSettings
            initialSettings={initialSettings.plateMatching}
          />
        );
      case "plateReview":
        return <PlateReviewSettings />;
      case "push":
        return renderPushSection();
      case "homeassistant":
        return renderHomeAssistantSection();
      case "security":
        return renderSecuritySection();
      case "privacy":
        return renderPrivacySection();
      case "release":
        return renderReleaseSection();
      case "blueiris":
        return renderBlueirisSection();
      default:
        return null;
    }
  };

  return (
    <SettingsShell
      activeId={activeSection}
      title="Settings"
      description="Application, security, privacy, and integration settings."
    >
              {/* Error/Success Messages */}
              {error && (
                <div className="mb-6 rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-destructive max-w-2xl">
                  {error}
                </div>
              )}
              {success && (
                <div className="mb-6 rounded-lg border border-green-500/20 bg-green-500/10 p-4 text-green-600 max-w-2xl">
                  Settings updated successfully!
                </div>
              )}

              {/* Form Content */}
              {!["security", "privacy", "release", "plateReview"].includes(activeSection) ? (
                <form action={handleSettingsSubmit}>
                  <div className="space-y-8">
                    {renderSection()}

                    {/* Save Button */}
                    <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex justify-start border-t border-border bg-background/95 px-4 py-4 shadow-[0_-8px_24px_-18px_rgba(0,0,0,0.45)] backdrop-blur sm:-mx-8 sm:-mb-8 sm:px-8">
                      <Button
                        type="submit"
                        disabled={isPending}
                        className="min-w-[120px]"
                      >
                        {isPending ? "Saving..." : "Save Changes"}
                      </Button>
                    </div>
                  </div>
                </form>
              ) : (
                renderSection()
              )}
    </SettingsShell>
  );
}

const IPWhitelistManager = ({ initialIPs = [], onUpdate }) => {
  const [newIP, setNewIP] = useState("");
  const [error, setError] = useState("");

  const isValidIP = (ip) => {
    // Basic IP validation (IPv4 and IPv6)
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Regex =
      /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^(([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$/;

    return ipv4Regex.test(ip) || ipv6Regex.test(ip);
  };

  const handleAddIP = () => {
    setError("");
    if (!newIP) {
      setError("Please enter an IP address");
      return;
    }

    if (!isValidIP(newIP)) {
      setError("Please enter a valid IP address");
      return;
    }

    if (initialIPs.includes(newIP)) {
      setError("This IP is already in the whitelist");
      return;
    }

    onUpdate([...initialIPs, newIP]);
    setNewIP("");
  };

  const handleRemoveIP = (ipToRemove) => {
    onUpdate(initialIPs.filter((ip) => ip !== ipToRemove));
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <Label htmlFor="ipInput" className="text-sm font-medium">
          IP Address Whitelist
        </Label>
        <div className="flex gap-3 max-w-md">
          <Input
            id="ipInput"
            value={newIP}
            onChange={(e) => setNewIP(e.target.value)}
            placeholder="Enter IP address"
            className="flex-1"
          />
          <Button onClick={handleAddIP} size="sm">
            Add IP
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <div className="flex flex-wrap gap-2">
        {initialIPs.map((ip) => (
          <Badge
            key={ip}
            variant="secondary"
            className="flex items-center gap-2 px-3 py-1"
          >
            {ip}
            <Button
              variant="ghost"
              size="sm"
              className="h-4 w-4 p-0 hover:bg-transparent"
              onClick={() => handleRemoveIP(ip)}
            >
              <X className="h-3 w-3" />
            </Button>
          </Badge>
        ))}
      </div>
    </div>
  );
};
