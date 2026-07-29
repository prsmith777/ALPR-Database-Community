"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, BellRing, Clock3, Mail, Play, ShieldCheck, Webhook } from "lucide-react";

import {
  previewStorageCleanup,
  runConfirmedStorageCleanup,
  saveStorageMaintenanceSettings,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function formatBytes(value) {
  if (!Number.isFinite(value)) return "Unavailable";
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** unit;
  return `${amount.toFixed(amount >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

function formatDuration(value) {
  if (!Number.isFinite(value)) return "Not available";
  if (value < 1000) return `${value} ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} sec`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} sec`;
}

function noticeClass(kind) {
  return kind === "error"
    ? "border-destructive/40 text-destructive"
    : "border-emerald-500/40 text-emerald-700 dark:text-emerald-300";
}

export default function StorageMaintenancePanel({ overview, canManage }) {
  const router = useRouter();
  const settings = overview?.settings || {};
  const scheduler = overview?.jobs?.scheduler || {};
  const cleanupRuns = overview?.runs || [];
  const lastCleanup = cleanupRuns.find((run) => run.mode === "execute") || null;
  const alertStates = overview?.alerts?.states || [];
  const alertDeliveries = overview?.alerts?.deliveries || [];
  const suppressedAlerts = alertStates.reduce(
    (total, item) => total + (Number(item.suppressedCount) || 0),
    0
  );
  const failedAlert = alertDeliveries.find((item) => item.status === "dead") || null;
  const [policy, setPolicy] = useState({
    warningPercent: String(settings.warningPercent ?? 80),
    criticalPercent: String(settings.criticalPercent ?? 90),
    checkMinutes: String(Math.round((settings.checkIntervalSeconds ?? 3600) / 60)),
    staleMinutes: String(Math.round((settings.staleAfterSeconds ?? 10800) / 60)),
    cooldownMinutes: String(Math.round((settings.alertCooldownSeconds ?? 21600) / 60)),
    orphanGraceDays: String(Math.round((settings.orphanGraceSeconds ?? 604800) / 86400)),
    emailEnabled: settings.emailEnabled === true,
    emailRecipients: (settings.emailRecipients || []).join(", "),
    webhookEnabled: settings.webhookEnabled === true,
    webhookUrl: settings.webhookUrl || "",
  });
  const [preview, setPreview] = useState(null);
  const [confirmation, setConfirmation] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [message, setMessage] = useState(null);
  const [isPending, startTransition] = useTransition();

  const nextExpectedCheck = useMemo(() => {
    if (!scheduler.heartbeatAt || !settings.checkIntervalSeconds) return null;
    return new Date(
      new Date(scheduler.heartbeatAt).getTime() + settings.checkIntervalSeconds * 1000
    ).toISOString();
  }, [scheduler.heartbeatAt, settings.checkIntervalSeconds]);

  function updatePolicy(key, value) {
    setPolicy((current) => ({ ...current, [key]: value }));
  }

  function savePolicy(event) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await saveStorageMaintenanceSettings({
        warningPercent: Number(policy.warningPercent),
        criticalPercent: Number(policy.criticalPercent),
        checkIntervalSeconds: Number(policy.checkMinutes) * 60,
        staleAfterSeconds: Number(policy.staleMinutes) * 60,
        alertCooldownSeconds: Number(policy.cooldownMinutes) * 60,
        orphanGraceSeconds: Number(policy.orphanGraceDays) * 86400,
        emailEnabled: policy.emailEnabled,
        emailRecipients: policy.emailRecipients
          .split(/[;,\n]/)
          .map((value) => value.trim())
          .filter(Boolean),
        webhookEnabled: policy.webhookEnabled,
        webhookUrl: policy.webhookUrl.trim(),
        cleanupEnabled: false,
        automaticCategories: [],
      });
      if (!result.success) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setMessage({ kind: "success", text: "Storage maintenance settings saved." });
      router.refresh();
    });
  }

  function createPreview() {
    setMessage(null);
    startTransition(async () => {
      const result = await previewStorageCleanup();
      if (!result.success) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setPreview(result.data);
      setConfirmation("");
      setMessage({
        kind: "success",
        text: `Preview ready: ${result.data.candidateCount.toLocaleString()} generated file(s), ${formatBytes(result.data.candidateBytes)}.`,
      });
      router.refresh();
    });
  }

  function executePreview() {
    if (!preview) return;
    setMessage(null);
    startTransition(async () => {
      const result = await runConfirmedStorageCleanup({
        previewToken: preview.previewToken,
        confirmation,
      });
      if (!result.success) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setDialogOpen(false);
      setPreview(null);
      setConfirmation("");
      setMessage({
        kind: result.data.failureCount ? "error" : "success",
        text: `Cleanup ${result.data.status}: ${formatBytes(result.data.reclaimedBytes)} reclaimed; ${result.data.failureCount} failure(s).`,
      });
      router.refresh();
    });
  }

  return (
    <div className="max-w-5xl space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <BellRing className="h-5 w-5 text-primary" aria-hidden="true" />
                Storage monitoring policy
              </CardTitle>
              <CardDescription className="mt-2">
                Configure capacity health, scheduler liveness, and rate-limited maintenance destinations.
              </CardDescription>
            </div>
            <Badge variant={overview?.severity === "critical" ? "destructive" : "secondary"}>
              {overview?.severity || "unknown"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={savePolicy}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <div className="space-y-2">
                <Label htmlFor="storage-warning">Warning %</Label>
                <Input id="storage-warning" type="number" min="1" max="98.9" step="0.1" value={policy.warningPercent} onChange={(event) => updatePolicy("warningPercent", event.target.value)} disabled={!canManage || isPending} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="storage-critical">Critical %</Label>
                <Input id="storage-critical" type="number" min="2" max="99.9" step="0.1" value={policy.criticalPercent} onChange={(event) => updatePolicy("criticalPercent", event.target.value)} disabled={!canManage || isPending} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="storage-check-minutes">Check every (min)</Label>
                <Input id="storage-check-minutes" type="number" min="1" max="1440" value={policy.checkMinutes} onChange={(event) => updatePolicy("checkMinutes", event.target.value)} disabled={!canManage || isPending} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="storage-stale-minutes">Stale after (min)</Label>
                <Input id="storage-stale-minutes" type="number" min="2" max="10080" value={policy.staleMinutes} onChange={(event) => updatePolicy("staleMinutes", event.target.value)} disabled={!canManage || isPending} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="storage-cooldown-minutes">Alert cooldown (min)</Label>
                <Input id="storage-cooldown-minutes" type="number" min="5" max="43200" value={policy.cooldownMinutes} onChange={(event) => updatePolicy("cooldownMinutes", event.target.value)} disabled={!canManage || isPending} />
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center gap-2 font-medium"><Mail className="h-4 w-4" aria-hidden="true" />Email alerts</div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={policy.emailEnabled} onChange={(event) => updatePolicy("emailEnabled", event.target.checked)} disabled={!canManage || isPending} />
                  Send maintenance alerts through the configured SMTP integration
                </label>
                <Label htmlFor="storage-alert-recipients">Recipients</Label>
                <Input id="storage-alert-recipients" type="text" value={policy.emailRecipients} onChange={(event) => updatePolicy("emailRecipients", event.target.value)} placeholder="owner@example.com, ops@example.com" disabled={!canManage || isPending} />
              </div>
              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center gap-2 font-medium"><Webhook className="h-4 w-4" aria-hidden="true" />Webhook alerts</div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={policy.webhookEnabled} onChange={(event) => updatePolicy("webhookEnabled", event.target.checked)} disabled={!canManage || isPending} />
                  Send HMAC-signed maintenance JSON through the configured webhook integration
                </label>
                <Label htmlFor="storage-alert-webhook">Destination URL</Label>
                <Input id="storage-alert-webhook" type="url" value={policy.webhookUrl} onChange={(event) => updatePolicy("webhookUrl", event.target.value)} placeholder="https://automation.example.com/alpr-maintenance" disabled={!canManage || isPending} />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,220px)_1fr] sm:items-end">
              <div className="space-y-2">
                <Label htmlFor="storage-orphan-grace">Derived orphan grace (days)</Label>
                <Input id="storage-orphan-grace" type="number" min="1" max="365" value={policy.orphanGraceDays} onChange={(event) => updatePolicy("orphanGraceDays", event.target.value)} disabled={!canManage || isPending} />
              </div>
              <div className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm">
                Automatic cleanup is disabled, with no approved automatic categories. Saving this policy cannot enable deletion.
              </div>
            </div>

            <Button type="submit" disabled={!canManage || isPending}>
              {isPending ? "Saving" : "Save monitoring policy"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Clock3 className="h-5 w-5 text-primary" aria-hidden="true" />Maintenance runtime</CardTitle>
            <CardDescription>Heartbeat and recent alert-delivery state.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between gap-4"><span className="text-muted-foreground">Scheduler</span><Badge variant={scheduler.status === "stale" || scheduler.status === "missing" ? "destructive" : "secondary"}>{scheduler.status || "unknown"}</Badge></div>
            <div className="flex justify-between gap-4"><span className="text-muted-foreground">Last heartbeat</span><span className="text-right font-medium">{formatDate(scheduler.heartbeatAt)}</span></div>
            <div className="flex justify-between gap-4"><span className="text-muted-foreground">Next expected check</span><span className="text-right font-medium">{formatDate(nextExpectedCheck)}</span></div>
            <div className="flex justify-between gap-4"><span className="text-muted-foreground">Recent alert events</span><span className="font-medium">{alertStates.length}</span></div>
            <div className="flex justify-between gap-4"><span className="text-muted-foreground">Suppressed repeats</span><span className="font-medium">{suppressedAlerts}</span></div>
            <div className="flex justify-between gap-4"><span className="text-muted-foreground">Pending/retrying alerts</span><span className="font-medium">{alertDeliveries.filter((item) => ["pending", "retry", "processing"].includes(item.status)).length}</span></div>
            <div className="flex justify-between gap-4"><span className="text-muted-foreground">Dead alert deliveries</span><span className="font-medium">{alertDeliveries.filter((item) => item.status === "dead").length}</span></div>
            {scheduler.lastError && <p className="rounded-md border border-destructive/40 p-3 text-destructive">{scheduler.lastError}</p>}
            {failedAlert?.lastError && <p className="rounded-md border border-destructive/40 p-3 text-destructive">Alert delivery failed: {failedAlert.lastError}</p>}
            <p className="text-xs text-muted-foreground">
              A stale loop can be detected while the application is alive. Whole-container or host outages still need an external uptime monitor.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />Guarded cleanup</CardTitle>
            <CardDescription>Preview first; only unreferenced generated files under derived/ are eligible.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><p className="text-muted-foreground">Last cleanup</p><p className="font-medium">{lastCleanup?.status || "Never run"}</p></div>
              <div><p className="text-muted-foreground">Completed</p><p className="font-medium">{formatDate(lastCleanup?.completedAt)}</p></div>
              <div><p className="text-muted-foreground">Duration</p><p className="font-medium">{formatDuration(lastCleanup?.durationMs)}</p></div>
              <div><p className="text-muted-foreground">Reclaimed</p><p className="font-medium">{formatBytes(lastCleanup?.reclaimedBytes)}</p></div>
              <div><p className="text-muted-foreground">Failures</p><p className="font-medium">{lastCleanup?.failureCount ?? 0}</p></div>
              <div><p className="text-muted-foreground">Next scheduled run</p><p className="font-medium">Automatic cleanup disabled</p></div>
            </div>
            {lastCleanup?.lastError && <p className="rounded-md border border-destructive/40 p-3 text-destructive">{lastCleanup.lastError}</p>}
            <Button type="button" variant="outline" disabled={!canManage || isPending} onClick={createPreview}>
              <Play className="mr-2 h-4 w-4" aria-hidden="true" />
              {isPending ? "Working" : "Run cleanup preview"}
            </Button>
            {preview && (
              <div className="rounded-md border p-3">
                <p className="font-medium">Preview #{preview.runId}</p>
                <p className="mt-1 text-muted-foreground">
                  {preview.candidateCount.toLocaleString()} derived file(s), {formatBytes(preview.candidateBytes)}. Expires {formatDate(preview.expiresAt)}.
                </p>
                <Button type="button" variant="destructive" className="mt-3" disabled={!canManage || isPending || preview.candidateCount === 0} onClick={() => setDialogOpen(true)}>
                  Review and confirm cleanup
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Execution rechecks all five database reference columns, file identity, age, real-path containment, and every ancestor for symbolic links. It never deletes rows, source images, thumbnails, releases, Docker objects, or backups.
            </p>
          </CardContent>
        </Card>
      </div>

      {message && <p className={`rounded-md border p-3 text-sm ${noticeClass(message.kind)}`}>{message.text}</p>}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />Confirm derived-file cleanup</DialogTitle>
            <DialogDescription>
              This deletes only the {preview?.candidateCount?.toLocaleString() || 0} generated derived-file candidate(s) from preview #{preview?.runId}. Changed or newly referenced files are skipped.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="storage-cleanup-confirmation">
              Type {preview?.confirmationPhrase || overview?.confirmationPhrase}
            </Label>
            <Input id="storage-cleanup-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" disabled={isPending} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={isPending}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={executePreview} disabled={isPending || confirmation !== preview?.confirmationPhrase}>
              {isPending ? "Running cleanup" : "Delete confirmed derived orphans"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
