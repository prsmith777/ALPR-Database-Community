"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  BellRing,
  CheckCircle2,
  Gauge,
  KeyRound,
  MailCheck,
  Save,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  TestTube2,
  UserRound,
  Webhook,
} from "lucide-react";

import { updateSettings } from "@/app/actions";
import PushoverUsageCard from "@/app/settings/PushoverUsageCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRouteTab } from "@/components/useRouteTab";

function ResultMessage({ message }) {
  if (!message) return null;
  return (
    <p className={`rounded-md border p-3 text-sm ${message.kind === "error" ? "border-destructive/50 text-destructive" : "border-emerald-500/50 text-emerald-700 dark:text-emerald-300"}`}>
      {message.text}
    </p>
  );
}

function StatusCard({ enabled, configured, detail }) {
  const ready = enabled && configured;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <p className="font-medium">Integration status</p>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        </div>
        <div className="flex gap-2">
          <Badge variant={enabled ? "default" : "secondary"}>{enabled ? "Enabled" : "Disabled"}</Badge>
          <Badge variant={configured ? "default" : "secondary"}>{configured ? "Configured" : "Needs setup"}</Badge>
          {ready ? <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-label="Ready" /> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function SaveMessage({ message, pending }) {
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t bg-background/95 py-4 backdrop-blur">
      <Button type="submit" disabled={pending}>
        <Save className="mr-2 h-4 w-4" />
        {pending ? "Saving…" : "Save settings"}
      </Button>
      <ResultMessage message={message} />
    </div>
  );
}

function TestCard({ channelType, ready, value, setValue, label, placeholder, inputType = "text", icon: Icon }) {
  const [message, setMessage] = useState(null);
  const [isPending, startTransition] = useTransition();

  function sendTest() {
    setMessage(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/notifications/channels/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelType, destination: value.trim() }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || "Test delivery failed");
        setMessage({ kind: "success", text: result.message });
      } catch (error) {
        setMessage({ kind: "error", text: String(error?.message || "Test delivery failed") });
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Icon className="h-4 w-4" />Test this integration</CardTitle>
        <CardDescription>Save your settings first. Tests bypass rules and do not create a plate read.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor={`${channelType}-test`}>{label}</Label>
          <Input
            id={`${channelType}-test`}
            type={inputType}
            value={value}
            onChange={(event) => setValue(channelType === "pushover" ? event.target.value.toUpperCase() : event.target.value)}
            placeholder={placeholder}
          />
        </div>
        <Button type="button" variant="outline" disabled={!ready || !value.trim() || isPending} onClick={sendTest}>
          <Send className="mr-2 h-4 w-4" />{isPending ? "Sending…" : "Send test"}
        </Button>
        {!ready ? <p className="text-xs text-muted-foreground">Enable and configure this integration before sending a test.</p> : null}
        <ResultMessage message={message} />
      </CardContent>
    </Card>
  );
}

export function PushoverSettings({ settings }) {
  const router = useRouter();
  const routeTab = useRouteTab({
    connection: "/settings/integrations/pushover",
    defaults: "/settings/integrations/pushover/defaults",
    usage: "/settings/integrations/pushover/usage",
    test: "/settings/integrations/pushover/test",
  }, "connection");
  const config = settings.notifications?.pushover || {};
  const configured = Boolean(config.appTokenConfigured && config.userKeyConfigured);
  const [samplePlate, setSamplePlate] = useState("TEST123");
  const [message, setMessage] = useState(null);
  const [isPending, startTransition] = useTransition();

  function submit(event) {
    event.preventDefault();
    setMessage(null);
    const form = event.currentTarget;
    const formData = new FormData(form);
    for (const name of ["pushoverEnabled", "clearPushoverAppToken", "clearPushoverUserKey"]) {
      formData.set(name, String(formData.has(name)));
    }
    startTransition(async () => {
      const result = await updateSettings(formData);
      setMessage(result.success ? { kind: "success", text: "Pushover settings saved." } : { kind: "error", text: result.error });
      if (result.success) router.refresh();
    });
  }

  return (
    <Tabs value={routeTab.active} onValueChange={routeTab.navigate} className="space-y-6">
      <TabsList className="grid h-auto w-full grid-cols-2 gap-1 p-1 sm:grid-cols-4">
        <TabsTrigger value="connection" className="gap-2 py-2"><KeyRound className="h-4 w-4" />Connection</TabsTrigger>
        <TabsTrigger value="defaults" className="gap-2 py-2"><Settings2 className="h-4 w-4" />Defaults</TabsTrigger>
        <TabsTrigger value="usage" className="gap-2 py-2"><Gauge className="h-4 w-4" />Usage</TabsTrigger>
        <TabsTrigger value="test" className="gap-2 py-2"><TestTube2 className="h-4 w-4" />Test</TabsTrigger>
      </TabsList>
      <StatusCard enabled={config.enabled} configured={configured} detail="Pushover can deliver short, high-visibility alerts from notification rules." />
      <form onSubmit={submit}>
        <TabsContent value="connection" forceMount className="mt-0 space-y-6 data-[state=inactive]:hidden">
          <Card>
            <CardHeader>
              <CardTitle>Connection and credentials</CardTitle>
              <CardDescription>Enable Pushover and enter the application token and user key from your Pushover account.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div><Label htmlFor="pushoverEnabled">Enable Pushover</Label><p className="mt-1 text-xs text-muted-foreground">Rules can use Pushover only while this is enabled.</p></div>
                <Switch id="pushoverEnabled" name="pushoverEnabled" defaultChecked={config.enabled} />
              </div>
              <div className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2"><Label htmlFor="pushoverAppToken">Application token</Label><Badge variant="outline">{config.appTokenConfigured ? "Saved" : "Not saved"}</Badge></div>
                  <PasswordInput id="pushoverAppToken" name="pushoverAppToken" visibilityLabel="Pushover application token" placeholder="Enter a replacement token" autoComplete="new-password" />
                  <p className="text-xs text-muted-foreground">Leave blank to keep the saved token.</p>
                  {config.appTokenConfigured ? <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" name="clearPushoverAppToken" />Clear saved token</label> : null}
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2"><Label htmlFor="pushoverUserKey">User key</Label><Badge variant="outline">{config.userKeyConfigured ? "Saved" : "Not saved"}</Badge></div>
                  <PasswordInput id="pushoverUserKey" name="pushoverUserKey" visibilityLabel="Pushover user key" placeholder="Enter a replacement key" autoComplete="new-password" />
                  <p className="text-xs text-muted-foreground">Leave blank to keep the saved key.</p>
                  {config.userKeyConfigured ? <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" name="clearPushoverUserKey" />Clear saved key</label> : null}
                </div>
              </div>
            </CardContent>
          </Card>
          <SaveMessage message={message} pending={isPending} />
        </TabsContent>
        <TabsContent value="defaults" forceMount className="mt-0 space-y-6 data-[state=inactive]:hidden">
          <Card>
            <CardHeader><CardTitle>Delivery defaults</CardTitle><CardDescription>These defaults apply when a rule does not override the presentation.</CardDescription></CardHeader>
            <CardContent className="grid gap-5 md:grid-cols-3">
              <div className="space-y-2"><Label htmlFor="pushoverTitle">Title</Label><Input id="pushoverTitle" name="pushoverTitle" defaultValue={config.title || "ALPR Alert"} /></div>
              <div className="space-y-2"><Label htmlFor="pushoverPriority">Priority</Label><Input id="pushoverPriority" name="pushoverPriority" type="number" min="-2" max="2" defaultValue={config.priority ?? 1} /></div>
              <div className="space-y-2"><Label htmlFor="pushoverSound">Sound</Label><Input id="pushoverSound" name="pushoverSound" defaultValue={config.sound || "pushover"} /></div>
            </CardContent>
          </Card>
          <SaveMessage message={message} pending={isPending} />
        </TabsContent>
      </form>
      <TabsContent value="usage" className="mt-0"><PushoverUsageCard /></TabsContent>
      <TabsContent value="test" className="mt-0">
        <TestCard channelType="pushover" ready={config.enabled && configured} value={samplePlate} setValue={setSamplePlate} label="Sample plate" placeholder="TEST123" icon={BellRing} />
      </TabsContent>
    </Tabs>
  );
}

export function EmailSettings({ settings }) {
  const router = useRouter();
  const routeTab = useRouteTab({
    connection: "/settings/integrations/email",
    sender: "/settings/integrations/email/sender",
    test: "/settings/integrations/email/test",
  }, "connection");
  const config = settings.notifications?.email || {};
  const configured = Boolean(config.host && config.from_address);
  const [recipient, setRecipient] = useState("");
  const [message, setMessage] = useState(null);
  const [isPending, startTransition] = useTransition();

  function submit(event) {
    event.preventDefault();
    setMessage(null);
    const form = event.currentTarget;
    const formData = new FormData(form);
    for (const name of ["emailEnabled", "emailSecure", "emailVerifyTls", "clearEmailPassword"]) {
      formData.set(name, String(formData.has(name)));
    }
    startTransition(async () => {
      const result = await updateSettings(formData);
      setMessage(result.success ? { kind: "success", text: "Email settings saved." } : { kind: "error", text: result.error });
      if (result.success) router.refresh();
    });
  }

  return (
    <Tabs value={routeTab.active} onValueChange={routeTab.navigate} className="space-y-6">
      <TabsList className="grid h-auto w-full grid-cols-1 gap-1 p-1 sm:grid-cols-3">
        <TabsTrigger value="connection" className="gap-2 py-2"><Server className="h-4 w-4" />SMTP Connection</TabsTrigger>
        <TabsTrigger value="sender" className="gap-2 py-2"><UserRound className="h-4 w-4" />Sender Identity</TabsTrigger>
        <TabsTrigger value="test" className="gap-2 py-2"><TestTube2 className="h-4 w-4" />Test</TabsTrigger>
      </TabsList>
      <StatusCard enabled={config.enabled} configured={configured} detail="Email rules send through your SMTP server or trusted relay." />
      <form onSubmit={submit}>
        <TabsContent value="connection" forceMount className="mt-0 space-y-6 data-[state=inactive]:hidden">
          <Card>
            <CardHeader><CardTitle>SMTP connection</CardTitle><CardDescription>Configure the server, transport security, and optional authentication.</CardDescription></CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between rounded-lg border p-4"><div><Label htmlFor="emailEnabled">Enable email</Label><p className="mt-1 text-xs text-muted-foreground">Rules can send email only while this is enabled.</p></div><Switch id="emailEnabled" name="emailEnabled" defaultChecked={config.enabled} /></div>
              <div className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2"><Label htmlFor="emailHost">SMTP host</Label><Input id="emailHost" name="emailHost" defaultValue={config.host} placeholder="smtp.example.com" /></div>
                <div className="space-y-2"><Label htmlFor="emailPort">SMTP port</Label><Input id="emailPort" name="emailPort" type="number" min="1" max="65535" defaultValue={config.port ?? 587} /></div>
                <div className="space-y-2"><Label htmlFor="emailUsername">Username (optional)</Label><Input id="emailUsername" name="emailUsername" defaultValue={config.username} autoComplete="off" /></div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2"><Label htmlFor="emailPassword">Password</Label><Badge variant="outline">{config.passwordConfigured ? "Saved" : "Not saved"}</Badge></div>
                  <PasswordInput id="emailPassword" name="emailPassword" visibilityLabel="SMTP password" placeholder="Enter a replacement password" autoComplete="new-password" />
                  <p className="text-xs text-muted-foreground">Leave username and password blank for a trusted relay.</p>
                  {config.passwordConfigured ? <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" name="clearEmailPassword" />Clear saved password</label> : null}
                </div>
              </div>
              <div className="flex flex-wrap gap-6 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" name="emailSecure" defaultChecked={config.secure} />Use implicit TLS (usually port 465)</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="emailVerifyTls" defaultChecked={config.verify_tls !== false} />Verify TLS certificate</label>
              </div>
            </CardContent>
          </Card>
          <SaveMessage message={message} pending={isPending} />
        </TabsContent>
        <TabsContent value="sender" forceMount className="mt-0 space-y-6 data-[state=inactive]:hidden">
          <Card>
            <CardHeader><CardTitle>Sender identity</CardTitle><CardDescription>Recipients see this address and display name.</CardDescription></CardHeader>
            <CardContent className="grid gap-5 md:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="emailFromAddress">From address</Label><Input id="emailFromAddress" name="emailFromAddress" type="email" defaultValue={config.from_address} placeholder="alpr@example.com" /></div>
              <div className="space-y-2"><Label htmlFor="emailFromName">From name</Label><Input id="emailFromName" name="emailFromName" defaultValue={config.from_name || "ALPR Database"} /></div>
            </CardContent>
          </Card>
          <SaveMessage message={message} pending={isPending} />
        </TabsContent>
      </form>
      <TabsContent value="test" className="mt-0">
        <TestCard channelType="email" ready={config.enabled && configured} value={recipient} setValue={setRecipient} label="Recipient" placeholder="recipient@example.com" inputType="email" icon={MailCheck} />
      </TabsContent>
    </Tabs>
  );
}

export function WebhookSettings({ settings }) {
  const router = useRouter();
  const routeTab = useRouteTab({
    delivery: "/settings/integrations/webhook",
    safety: "/settings/integrations/webhook/safety",
    test: "/settings/integrations/webhook/test",
  }, "delivery");
  const config = settings.notifications?.webhook || {};
  const configured = Boolean(config.signingSecretConfigured);
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState(null);
  const [isPending, startTransition] = useTransition();

  function submit(event) {
    event.preventDefault();
    setMessage(null);
    const form = event.currentTarget;
    const formData = new FormData(form);
    for (const name of ["webhookEnabled", "webhookAllowHttp", "webhookAllowPrivateNetworks", "clearWebhookSigningSecret"]) {
      formData.set(name, String(formData.has(name)));
    }
    startTransition(async () => {
      const result = await updateSettings(formData);
      setMessage(result.success ? { kind: "success", text: "Webhook settings saved." } : { kind: "error", text: result.error });
      if (result.success) router.refresh();
    });
  }

  return (
    <Tabs value={routeTab.active} onValueChange={routeTab.navigate} className="space-y-6">
      <TabsList className="grid h-auto w-full grid-cols-1 gap-1 p-1 sm:grid-cols-3">
        <TabsTrigger value="delivery" className="gap-2 py-2"><KeyRound className="h-4 w-4" />Signing & Delivery</TabsTrigger>
        <TabsTrigger value="safety" className="gap-2 py-2"><ShieldCheck className="h-4 w-4" />Network Safety</TabsTrigger>
        <TabsTrigger value="test" className="gap-2 py-2"><TestTube2 className="h-4 w-4" />Test</TabsTrigger>
      </TabsList>
      <StatusCard enabled={config.enabled} configured={configured} detail="Webhook rules send signed JSON events to an HTTPS endpoint." />
      <form onSubmit={submit}>
        <TabsContent value="delivery" forceMount className="mt-0 space-y-6 data-[state=inactive]:hidden">
          <Card>
            <CardHeader><CardTitle>Signing and delivery</CardTitle><CardDescription>Every request includes an HMAC-SHA256 signature, event ID, and idempotency key.</CardDescription></CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between rounded-lg border p-4"><div><Label htmlFor="webhookEnabled">Enable webhooks</Label><p className="mt-1 text-xs text-muted-foreground">Rules can call webhook targets only while this is enabled.</p></div><Switch id="webhookEnabled" name="webhookEnabled" defaultChecked={config.enabled} /></div>
              <div className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2"><Label htmlFor="webhookSigningSecret">Signing secret</Label><Badge variant="outline">{config.signingSecretConfigured ? "Saved" : "Not saved"}</Badge></div>
                  <PasswordInput id="webhookSigningSecret" name="webhookSigningSecret" visibilityLabel="Webhook signing secret" placeholder="Enter a replacement secret" autoComplete="new-password" />
                  <p className="text-xs text-muted-foreground">Receivers verify the raw body using the X-ALPR-Signature header.</p>
                  {config.signingSecretConfigured ? <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" name="clearWebhookSigningSecret" />Clear saved secret</label> : null}
                </div>
                <div className="space-y-2"><Label htmlFor="webhookTimeoutSeconds">Request timeout (seconds)</Label><Input id="webhookTimeoutSeconds" name="webhookTimeoutSeconds" type="number" min="2" max="30" defaultValue={config.timeout_seconds ?? 10} /></div>
              </div>
            </CardContent>
          </Card>
          <SaveMessage message={message} pending={isPending} />
        </TabsContent>
        <TabsContent value="safety" forceMount className="mt-0 space-y-6 data-[state=inactive]:hidden">
          <Card>
            <CardHeader><CardTitle>Network safety</CardTitle><CardDescription>Secure defaults block unsafe targets. Relax them only for a trusted local integration.</CardDescription></CardHeader>
            <CardContent className="space-y-4 text-sm">
              <label className="flex items-start gap-3 rounded-lg border p-4"><input type="checkbox" name="webhookAllowHttp" defaultChecked={config.allow_http} className="mt-1" /><span><span className="font-medium">Allow unencrypted HTTP</span><span className="mt-1 block text-xs text-muted-foreground">Use only on a network you control.</span></span></label>
              <label className="flex items-start gap-3 rounded-lg border p-4"><input type="checkbox" name="webhookAllowPrivateNetworks" defaultChecked={config.allow_private_networks} className="mt-1" /><span><span className="font-medium">Allow private-network targets</span><span className="mt-1 block text-xs text-muted-foreground">Permits 10.x, 172.16–31.x, and 192.168.x targets. Loopback and other special-use addresses remain blocked.</span></span></label>
            </CardContent>
          </Card>
          <SaveMessage message={message} pending={isPending} />
        </TabsContent>
      </form>
      <TabsContent value="test" className="mt-0">
        <TestCard channelType="webhook" ready={config.enabled && configured} value={target} setValue={setTarget} label="Destination URL" placeholder="https://automation.example.com/alpr" inputType="url" icon={Webhook} />
      </TabsContent>
    </Tabs>
  );
}
