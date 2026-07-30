"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore, Box, HardDrive, RefreshCw, ShieldCheck } from "lucide-react";

import {
  previewHostMaintenance,
  refreshHostMaintenancePreview,
  runConfirmedHostMaintenance,
  setScheduledHostMaintenancePolicy,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const CATEGORIES = Object.freeze([
  {
    key: "docker-build-cache",
    title: "Docker build cache",
    Icon: HardDrive,
    description: "ALPR-managed, non-mutable, non-shared cache unused for at least seven days.",
    boundary: "Containers, images, volumes, networks, databases, and captures are never included.",
  },
  {
    key: "unused-alpr-images",
    title: "Unused ALPR release images",
    Icon: Box,
    description: "Explicitly retired ALPR images older than the fixed seven-day worker grace with no protected reference.",
    boundary: "Manual preview and confirmation only. Scheduled image pruning is not supported.",
  },
  {
    key: "rollout-backups",
    title: "Verified rollout backups",
    Icon: ArchiveRestore,
    description: "Verified, expired rollout backups beyond the configured minimum retention.",
    boundary: "Protected, current-release, rollback-chain, unverified, partial, linked, or foreign backups are never included.",
  },
]);

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const amount = bytes / 1024 ** unit;
  return `${amount.toFixed(amount >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

function compactWorkerValue(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9:_.@+-]{0,79}$/.test(text) ? text : "Unavailable";
}

function field(record, camel, snake) {
  return record?.[camel] ?? record?.[snake];
}

function categoryOf(record) {
  return field(record, "category", "category");
}

function intentTypeOf(record) {
  return field(record, "intentType", "intent_type");
}

function lastFor(records, category, predicate = () => true) {
  return (records || []).find((record) => categoryOf(record) === category && predicate(record)) || null;
}

function lastRunFor(runs, category) {
  return (runs || []).find((run) =>
    run?.configuration?.category === category || field(run, "jobName", "job_name") === `host-maintenance:${category}`
  ) || null;
}

function statusBadge(config, configured) {
  if (!configured) return { label: "Configuration unavailable", variant: "destructive" };
  if (config.circuitBreakerOpen) return { label: "Suspended", variant: "destructive" };
  if (config.scheduledEnabled) return { label: "Scheduled", variant: "secondary" };
  if (!config.automationSupported) return { label: "Manual only", variant: "outline" };
  return { label: "Default off", variant: "outline" };
}

function requestSummary(request) {
  if (!request) return null;
  const status = String(request.status || "pending").replaceAll("_", " ");
  if (request.operation === "execute") {
    if (status === "completed") return `Cleanup completed; ${formatBytes(request.reclaimedBytes)} reclaimed.`;
    if (status === "failed") return "Cleanup failed. Protected details are available in the host-worker logs.";
    return `Cleanup ${status}. Use Check status to poll the host worker.`;
  }
  if (status === "completed") {
    const count = Number(request.candidateCount || 0);
    return count === 0
      ? "Preview complete: 0 candidates (0 B). Nothing is currently eligible."
      : `Preview complete: ${count.toLocaleString()} candidates, ${formatBytes(request.candidateBytes)}.`;
  }
  if (status === "failed") return "Preview failed. Protected details are available in the host-worker logs.";
  return `Preview ${status}. Use Check status to poll the host worker.`;
}

function initialDrafts(configs) {
  return Object.fromEntries(CATEGORIES.map(({ key }) => {
    const config = (configs || []).find((item) => item.category === key) || {};
    return [key, {
      intervalDays: String(Math.max(1, Math.round(Number(config.intervalSeconds || 604800) / 86400))),
      retainedVerifiedCount: String(config.retainedVerifiedCount ?? 5),
      minimumAgeDays: String(config.minimumAgeDays ?? (key === "docker-build-cache" ? 7 : 30)),
    }];
  }));
}

export default function HostMaintenancePanel({ overview = {}, canManage, canApproveAutomaticCleanup }) {
  const router = useRouter();
  const [requests, setRequests] = useState({});
  const [manualConfirmations, setManualConfirmations] = useState({});
  const [activationConfirmations, setActivationConfirmations] = useState({});
  const [drafts, setDrafts] = useState(() => initialDrafts(overview.configs));
  const [notice, setNotice] = useState(null);
  const [pendingCategory, setPendingCategory] = useState(null);
  const [isPending, startTransition] = useTransition();
  const worker = overview.worker || {};
  const workerHealthy = worker.status === "healthy";
  const workerLabel = worker.status === "stale"
    ? "Host worker stale"
    : workerHealthy
      ? "Host worker healthy"
      : "Host worker unavailable";

  function runAction(category, task) {
    setNotice(null);
    setPendingCategory(category);
    startTransition(async () => {
      try {
        await task();
      } finally {
        setPendingCategory(null);
      }
    });
  }

  function queuePreview(category) {
    runAction(category, async () => {
      const result = await previewHostMaintenance({ category });
      if (!result.success) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setRequests((current) => ({ ...current, [category]: { ...result.data, operation: "preview" } }));
      setManualConfirmations((current) => ({ ...current, [category]: "" }));
      setNotice({ kind: "success", text: "Preview queued. Use Check status until the host worker finishes." });
    });
  }

  function pollRequest(category) {
    const request = requests[category];
    if (!request?.requestId) return;
    runAction(category, async () => {
      const result = await refreshHostMaintenancePreview({ requestId: request.requestId });
      if (!result.success) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setRequests((current) => ({
        ...current,
        [category]: {
          ...result.data,
          operation: current[category]?.operation || "preview",
          previewToken: result.data.previewToken || current[category]?.previewToken || null,
        },
      }));
      if (["completed", "failed"].includes(result.data.status)) router.refresh();
    });
  }

  function queueExecution(category) {
    const request = requests[category];
    runAction(category, async () => {
      const result = await runConfirmedHostMaintenance({
        requestId: request?.requestId,
        previewToken: request?.previewToken,
        confirmation: manualConfirmations[category] || "",
      });
      if (!result.success) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setRequests((current) => ({ ...current, [category]: { ...result.data, operation: "execute" } }));
      setManualConfirmations((current) => ({ ...current, [category]: "" }));
      setNotice({ kind: "success", text: "Cleanup queued. The worker will revalidate the exact preview set before acting." });
      router.refresh();
    });
  }

  function changeSchedule(config, enabled) {
    const category = config.category;
    const draft = drafts[category];
    runAction(category, async () => {
      const result = await setScheduledHostMaintenancePolicy({
        category,
        enabled,
        confirmation: enabled ? activationConfirmations[category] || "" : "",
        intervalSeconds: Number(draft.intervalDays) * 86400,
        retainedVerifiedCount: Number(draft.retainedVerifiedCount),
        minimumAgeDays: Number(draft.minimumAgeDays),
      });
      if (!result.success) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setActivationConfirmations((current) => ({ ...current, [category]: "" }));
      setNotice({
        kind: "success",
        text: enabled ? "This category's schedule is now active." : "This category's schedule is disabled.",
      });
      router.refresh();
    });
  }

  function updateDraft(category, key, value) {
    setDrafts((current) => ({ ...current, [category]: { ...current[category], [key]: value } }));
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
              Host cleanup and retention
            </CardTitle>
            <CardDescription className="mt-2">
              Preview-first controls for three isolated categories. Scheduled cleanup is separately approved and defaults off.
            </CardDescription>
          </div>
          <Badge variant={workerHealthy ? "secondary" : "destructive"}>
            {workerLabel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-3">
          <div><p className="text-muted-foreground">Last heartbeat</p><p className="font-medium">{formatDate(field(worker, "heartbeatAt", "heartbeat_at"))}</p></div>
          <div><p className="text-muted-foreground">Environment</p><p className="font-medium">{compactWorkerValue(field(worker, "environmentId", "environment_id"))}</p></div>
          <div><p className="text-muted-foreground">Worker version</p><p className="font-medium">{compactWorkerValue(field(worker, "workerGeneration", "worker_generation"))}</p></div>
        </div>

        {!workerHealthy && (
          <p className="rounded-md border border-amber-500/40 p-3 text-amber-700 dark:text-amber-300">
            Candidate counts are unavailable, not zero. Controls remain locked until the separate fixed host worker reports a fresh, healthy inventory.
          </p>
        )}
        {field(worker, "lastError", "last_error") && (
          <p className="rounded-md border border-destructive/40 p-3 text-destructive">
            The latest worker heartbeat reported an error. Details remain in protected host logs.
          </p>
        )}
        <p className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3">
          These controls never prune Docker volumes, containers, or networks and never alter database records, captures, source images, or thumbnails.
        </p>

        <div className="grid gap-4 xl:grid-cols-3">
          {CATEGORIES.map((definition) => {
            const config = (overview.configs || []).find((item) => item.category === definition.key);
            const configured = Boolean(config);
            const effectiveConfig = config || {
              category: definition.key,
              automationSupported: false,
              scheduledEnabled: false,
              circuitBreakerOpen: false,
              activationRevision: 0,
            };
            const badge = statusBadge(effectiveConfig, configured);
            const request = requests[definition.key];
            const preview = lastFor(overview.intents, definition.key, (item) => intentTypeOf(item) === "preview");
            const execution = lastFor(overview.intents, definition.key, (item) => ["execute", "scheduled"].includes(intentTypeOf(item)));
            const run = lastRunFor(overview.runs, definition.key);
            const lastFailure = lastFor(overview.intents, definition.key, (item) => item.status === "failed");
            const confirmationPhrase = request?.confirmationPhrase || overview.confirmationPhrases?.[definition.key] || "";
            const activationPhrase = overview.activationPhrases?.[definition.key] || "";
            const expiresAt = request?.expiresAt ? new Date(request.expiresAt).getTime() : 0;
            const previewExpired = !expiresAt || expiresAt <= Date.now();
            const categoryPending = isPending && pendingCategory === definition.key;
            const blocked = !workerHealthy || !configured || effectiveConfig.circuitBreakerOpen || isPending;
            const candidateCount = Number(request?.candidateCount || 0);
            const canExecute = canManage && !blocked && request?.operation === "preview" && request?.status === "completed" &&
              Boolean(request.previewToken) && !previewExpired && candidateCount > 0 &&
              manualConfirmations[definition.key] === confirmationPhrase;
            const draft = drafts[definition.key];
            const Icon = definition.Icon;

            return (
              <section key={definition.key} className="space-y-4 rounded-lg border p-4" aria-labelledby={`host-${definition.key}-title`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 id={`host-${definition.key}-title`} className="flex items-center gap-2 font-semibold">
                      <Icon className="h-4 w-4 text-primary" aria-hidden="true" />{definition.title}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">{definition.description}</p>
                  </div>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{definition.boundary}</p>

                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  <div><dt className="text-muted-foreground">Last preview</dt><dd className="font-medium">{preview ? `${preview.status} - ${formatDate(field(preview, "completedAt", "completed_at") || field(preview, "requestedAt", "requested_at"))}` : "Never"}</dd></div>
                  <div><dt className="text-muted-foreground">Preview size</dt><dd className="font-medium">{preview ? `${Number(field(preview, "candidateCount", "candidate_count") || 0).toLocaleString()} / ${formatBytes(field(preview, "candidateBytes", "candidate_bytes"))}` : "Not available"}</dd></div>
                  <div><dt className="text-muted-foreground">Last cleanup</dt><dd className="font-medium">{execution ? `${execution.status} - ${formatDate(field(execution, "completedAt", "completed_at") || field(execution, "requestedAt", "requested_at"))}` : "Never"}</dd></div>
                  <div><dt className="text-muted-foreground">Reclaimed</dt><dd className="font-medium">{run ? formatBytes(field(run, "reclaimedBytes", "reclaimed_bytes")) : "Not available"}</dd></div>
                  <div><dt className="text-muted-foreground">Last failure</dt><dd className="font-medium">{lastFailure ? formatDate(field(lastFailure, "completedAt", "completed_at") || field(lastFailure, "requestedAt", "requested_at")) : "None reported"}</dd></div>
                  <div><dt className="text-muted-foreground">Next run</dt><dd className="font-medium">{effectiveConfig.scheduledEnabled ? formatDate(effectiveConfig.nextRunAt) : "Not scheduled"}</dd></div>
                  <div><dt className="text-muted-foreground">Safety breaker</dt><dd className="font-medium">{effectiveConfig.circuitBreakerOpen ? "Open - controls locked" : "Closed"}</dd></div>
                  <div><dt className="text-muted-foreground">Approval revision</dt><dd className="font-medium">{effectiveConfig.activationRevision || "None"}</dd></div>
                  {definition.key === "docker-build-cache" && <div><dt className="text-muted-foreground">Minimum unused age</dt><dd className="font-medium">{Math.max(7, Number(effectiveConfig.minimumAgeDays || 7))} days</dd></div>}
                </dl>

                {effectiveConfig.circuitBreakerOpen && (
                  <p className="rounded-md border border-destructive/40 p-2 text-xs text-destructive">
                    Cleanup is suspended after a failure. Resolve and acknowledge it through the protected maintenance process before retrying.
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => queuePreview(definition.key)} disabled={!canManage || blocked}>
                    Queue safe preview
                  </Button>
                  {request?.requestId && (
                    <Button type="button" variant="outline" size="sm" onClick={() => pollRequest(definition.key)} disabled={!canManage || blocked}>
                      <RefreshCw className={`mr-2 h-3.5 w-3.5 ${categoryPending ? "animate-spin" : ""}`} aria-hidden="true" />
                      Check status
                    </Button>
                  )}
                </div>

                {request && (
                  <div className="rounded-md border p-3 text-xs" role="status">
                    <p>{requestSummary(request)}</p>
                    {request.operation === "preview" && request.status === "completed" && candidateCount > 0 && (
                      <p className="mt-1 text-muted-foreground">Preview expires {formatDate(request.expiresAt)}. Candidate identities remain hidden.</p>
                    )}
                  </div>
                )}

                {request?.operation === "preview" && request.status === "completed" && candidateCount > 0 && (
                  <div className="space-y-2 rounded-md border border-destructive/30 p-3">
                    <Label htmlFor={`host-confirm-${definition.key}`}>Type {confirmationPhrase}</Label>
                    <Input
                      id={`host-confirm-${definition.key}`}
                      value={manualConfirmations[definition.key] || ""}
                      onChange={(event) => setManualConfirmations((current) => ({ ...current, [definition.key]: event.target.value }))}
                      autoComplete="off"
                      disabled={!canManage || blocked || previewExpired || !request.previewToken}
                    />
                    <Button type="button" variant="destructive" size="sm" onClick={() => queueExecution(definition.key)} disabled={!canExecute}>
                      Confirm this preview only
                    </Button>
                    {previewExpired && <p className="text-xs text-destructive">This preview is stale. Queue a new preview before cleanup.</p>}
                  </div>
                )}

                {definition.key === "unused-alpr-images" ? (
                  <p className="rounded-md border p-3 text-xs">Automation unsupported: retired release images remain preview-and-confirm manual only.</p>
                ) : (
                  <div className="space-y-3 rounded-md border p-3">
                    <p className="font-medium">Scheduled cleanup</p>
                    <div className="space-y-2">
                      <Label htmlFor={`host-interval-${definition.key}`}>Run every (days)</Label>
                      <Input id={`host-interval-${definition.key}`} type="number" min="1" max="30" value={draft.intervalDays} onChange={(event) => updateDraft(definition.key, "intervalDays", event.target.value)} disabled={!canApproveAutomaticCleanup || blocked || effectiveConfig.scheduledEnabled} />
                    </div>
                    {definition.key === "rollout-backups" && (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-2">
                          <Label htmlFor="host-backup-retain">Keep newest verified</Label>
                          <Input id="host-backup-retain" type="number" min="5" max="50" value={draft.retainedVerifiedCount} onChange={(event) => updateDraft(definition.key, "retainedVerifiedCount", event.target.value)} disabled={!canApproveAutomaticCleanup || blocked || effectiveConfig.scheduledEnabled} />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="host-backup-age">Minimum age (days)</Label>
                          <Input id="host-backup-age" type="number" min="30" max="365" value={draft.minimumAgeDays} onChange={(event) => updateDraft(definition.key, "minimumAgeDays", event.target.value)} disabled={!canApproveAutomaticCleanup || blocked || effectiveConfig.scheduledEnabled} />
                        </div>
                      </div>
                    )}
                    {definition.key === "docker-build-cache" && (
                      <div className="space-y-2">
                        <Label htmlFor="host-cache-age">Minimum unused age (days)</Label>
                        <Input id="host-cache-age" type="number" min="7" max="365" value={draft.minimumAgeDays} onChange={(event) => updateDraft(definition.key, "minimumAgeDays", event.target.value)} disabled={!canApproveAutomaticCleanup || blocked || effectiveConfig.scheduledEnabled} />
                      </div>
                    )}
                    {!effectiveConfig.scheduledEnabled ? (
                      <>
                        <Label htmlFor={`host-activate-${definition.key}`}>To activate this category only, type {activationPhrase}</Label>
                        <Input id={`host-activate-${definition.key}`} value={activationConfirmations[definition.key] || ""} onChange={(event) => setActivationConfirmations((current) => ({ ...current, [definition.key]: event.target.value }))} autoComplete="off" disabled={!canApproveAutomaticCleanup || blocked || !effectiveConfig.automationSupported} />
                        <Button type="button" variant="destructive" size="sm" onClick={() => changeSchedule(effectiveConfig, true)} disabled={!canApproveAutomaticCleanup || blocked || !effectiveConfig.automationSupported || !activationPhrase || activationConfirmations[definition.key] !== activationPhrase}>
                          Activate scheduled cleanup
                        </Button>
                      </>
                    ) : (
                      <Button type="button" variant="outline" size="sm" onClick={() => changeSchedule(effectiveConfig, false)} disabled={!canApproveAutomaticCleanup || !configured || isPending}>
                        Disable scheduled cleanup
                      </Button>
                    )}
                    {!canApproveAutomaticCleanup && <p className="text-xs text-muted-foreground">Administrator automatic-cleanup approval permission is required.</p>}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {notice && (
          <p className={`rounded-md border p-3 ${notice.kind === "error" ? "border-destructive/40 text-destructive" : "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"}`} role="status">
            {notice.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
