"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Database,
  HardDrive,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  XCircle,
} from "lucide-react";

import {
  cancelVehicleImageAssetCatalog,
  confirmVehicleImageAssetCatalogBatch,
  getVehicleImageAssetCatalogOverview,
  previewVehicleImageAssetCatalog,
  retryVehicleImageAssetCatalogJob,
  setVehicleImageAssetCatalogPaused,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const BATCH_SIZES = Object.freeze([1, 5, 25, 250]);
const ACTIVE_RUN_STATUSES = new Set(["previewing", "running"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "cancelled", "failed"]);

const STATUS_LABELS = Object.freeze({
  previewing: "Calculating preview",
  ready: "Ready",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Needs attention",
});

function count(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function formatCount(value) {
  return count(value).toLocaleString();
}

function formatBytes(value) {
  const bytes = count(value);
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = bytes / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function statusVariant(status) {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  return "secondary";
}

function workerErrorText(value) {
  if (typeof value === "string") return value;
  const code = String(value?.code || "").trim();
  const message = String(value?.message || "Canonical Overview catalog worker failed.").trim();
  return code ? `${code}: ${message}` : message;
}

function Metric({ label, value, detail }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {detail ? <div className="mt-1 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function overviewFromResult(result) {
  const overview = result?.data?.overview;
  if (!result?.success || !overview) {
    throw new Error(result?.error || "Unable to load the canonical Overview catalog.");
  }
  return overview;
}

export default function VehicleImageAssetCatalogPanel({ initialOverview = null }) {
  const [overview, setOverview] = useState(initialOverview);
  const [batchSize, setBatchSize] = useState("5");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const run = overview?.latestRun || null;
  const catalog = overview?.catalog || {};
  const retention = overview?.retention || {};
  const counts = run?.counts || {};
  const retryCandidates = Array.isArray(overview?.retryCandidates)
    ? overview.retryCandidates.slice(0, 25)
    : [];
  const status = run?.status || "not_previewed";
  const activeJobs = count(counts.queued) + count(counts.processing) + count(counts.retryable);
  const pollingActive = status === "previewing" || (status === "running" && activeJobs > 0);
  const previewRemaining = count(counts.previewed);
  const total = count(counts.total);
  const previewFinished = Math.max(
    0,
    total - count(counts.pendingPreview) - count(counts.previewing)
  );
  const catalogFinished = [
    "cataloged",
    "alreadyCurrent",
    "superseded",
    "unavailable",
    "invalid",
    "failed",
    "cancelled",
  ].reduce((sum, key) => sum + count(counts[key]), 0);
  const progressFinished = run?.phase === "preview" ? previewFinished : catalogFinished;
  const progress = total ? Math.min(100, Math.round(progressFinished / total * 100)) : 0;
  const canPreview = overview && (!run || TERMINAL_RUN_STATUSES.has(status));
  const canCatalog = overview
    && ["ready", "running"].includes(status)
    && Boolean(run?.previewFingerprint)
    && previewRemaining > 0
    && activeJobs === 0;
  const canPause = ACTIVE_RUN_STATUSES.has(status);
  const canCancel = ["previewing", "ready", "running", "paused"].includes(status)
    && count(counts.previewing) + count(counts.processing) === 0;
  const canRetryItems = ["ready", "completed", "failed"].includes(status);

  const previewMetrics = useMemo(() => ([
    { label: "campaign candidates", value: formatCount(counts.total) },
    { label: "identity eligible", value: formatCount(counts.identityEligible) },
    { label: "display only", value: formatCount(counts.displayOnly) },
    { label: "unique JPEGs", value: formatCount(counts.uniqueHashes) },
    { label: "logical source size", value: formatBytes(counts.logicalSourceBytes) },
    { label: "unique content size", value: formatBytes(counts.uniqueBytes) },
    { label: "already stored bytes", value: formatBytes(counts.existingAssetBytes) },
    { label: "additional storage", value: formatBytes(counts.projectedNewBytes) },
    { label: "duplicate copies avoided", value: formatBytes(counts.duplicateBytesAvoided) },
  ]), [
    counts.displayOnly,
    counts.duplicateBytesAvoided,
    counts.existingAssetBytes,
    counts.identityEligible,
    counts.logicalSourceBytes,
    counts.projectedNewBytes,
    counts.total,
    counts.uniqueBytes,
    counts.uniqueHashes,
  ]);

  useEffect(() => {
    if (!pollingActive) return undefined;
    let cancelled = false;
    let inFlight = false;
    const timer = window.setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await getVehicleImageAssetCatalogOverview();
        const next = overviewFromResult(result);
        if (!cancelled) setOverview(next);
      } catch (error) {
        if (!cancelled) setMessage(error.message);
      } finally {
        inFlight = false;
      }
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pollingActive]);

  const refresh = async () => {
    setBusy("refresh");
    setMessage("");
    try {
      const result = await getVehicleImageAssetCatalogOverview();
      setOverview(overviewFromResult(result));
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };

  const startPreview = async () => {
    setBusy("preview");
    setMessage("");
    try {
      const result = await previewVehicleImageAssetCatalog();
      setOverview(overviewFromResult(result));
      setMessage("Preview started. No canonical files or read links are created while the preview is calculated.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };

  const confirmBatch = async () => {
    if (!run) return;
    setBusy("confirm");
    setMessage("");
    try {
      const result = await confirmVehicleImageAssetCatalogBatch({
        runId: run.id,
        previewFingerprint: run.previewFingerprint,
        limit: Number(batchSize),
      });
      setOverview(overviewFromResult(result));
      const queued = count(result.data?.confirmation?.queued);
      setMessage(`Queued ${queued.toLocaleString()} canonical Overview link${queued === 1 ? "" : "s"}.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };

  const togglePaused = async () => {
    if (!run) return;
    const paused = status !== "paused";
    setBusy("pause");
    setMessage("");
    try {
      const result = await setVehicleImageAssetCatalogPaused({ runId: run.id, paused });
      setOverview(overviewFromResult(result));
      setMessage(paused
        ? "Canonical Overview catalog work will pause after the current item."
        : "Canonical Overview catalog work resumed.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };

  const cancelCampaign = async () => {
    if (!run) return;
    setBusy("cancel");
    setMessage("");
    try {
      const result = await cancelVehicleImageAssetCatalog({ runId: run.id });
      setOverview(overviewFromResult(result));
      setMessage("Remaining catalog work was cancelled. Canonical assets and links already completed were preserved.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };

  const retryJob = async (jobId) => {
    setBusy(`retry:${jobId}`);
    setMessage("");
    try {
      const result = await retryVehicleImageAssetCatalogJob({ jobId });
      setOverview(overviewFromResult(result));
      setMessage("The failed item was queued for its bounded operator retry.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" /> Canonical Overview catalog
            </CardTitle>
            <CardDescription className="mt-1 max-w-3xl">
              Catalog ready Entry and Street Overview JPEGs by exact SHA-256 so byte-identical images are stored once and safely linked to every eligible read.
            </CardDescription>
          </div>
          <Badge variant={statusVariant(status)}>{STATUS_LABELS[status] || "Not previewed"}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-sm">
          <div className="font-medium">Local catalog only</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Existing Vehicle Views and ReID remain unchanged. Plate Recognizer and other external services are not contacted.
          </p>
        </div>

        {overview ? (
          <>
            <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="eligible reads" value={formatCount(catalog.eligibleReads)} />
              <Metric
                label="current links"
                value={formatCount(catalog.currentLinks)}
                detail={`${formatCount(catalog.identityEligibleLinks)} identity · ${formatCount(catalog.displayOnlyLinks)} display-only`}
              />
              <Metric label="stale links" value={formatCount(catalog.staleLinks)} />
              <Metric label="unique assets" value={formatCount(catalog.assetCount)} />
              <Metric label="asset storage" value={formatBytes(catalog.assetBytes)} />
              <Metric label="read links" value={formatCount(catalog.readLinks)} />
            </div>

            {run ? (
              <div className="space-y-4 rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">Campaign #{run.id}</div>
                    <div className="text-xs text-muted-foreground">
                      Frozen through read #{formatCount(run.maxReadId)} · {run.phase === "preview" ? "preview scan" : run.phase === "catalog" ? "catalog batches" : "complete"}
                    </div>
                  </div>
                  <Badge variant="outline">{formatCount(previewRemaining)} ready for a batch</Badge>
                </div>

                <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-3 lg:grid-cols-5">
                  {previewMetrics.map((metric) => (
                    <Metric key={metric.label} label={metric.label} value={metric.value} />
                  ))}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>{formatCount(progressFinished)} of {formatCount(total)} inspected or terminal</span>
                    <span>{progress}%</span>
                  </div>
                  <Progress value={progress} aria-label={`${progress}% of canonical Overview campaign complete`} />
                  <div className="grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-6">
                    <div><span className="font-medium">{formatCount(counts.queued)}</span> queued</div>
                    <div><span className="font-medium">{formatCount(counts.processing)}</span> processing</div>
                    <div><span className="font-medium">{formatCount(counts.cataloged)}</span> cataloged</div>
                    <div><span className="font-medium">{formatCount(counts.alreadyCurrent)}</span> already current</div>
                    <div><span className="font-medium">{formatCount(counts.failed)}</span> failed</div>
                    <div><span className="font-medium">{formatCount(counts.superseded)}</span> source changed</div>
                  </div>
                </div>

                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[9rem] space-y-2">
                    <Label>Next batch</Label>
                    <Select value={batchSize} onValueChange={setBatchSize}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {BATCH_SIZES.map((size) => (
                          <SelectItem key={size} value={String(size)}>{size} {size === 1 ? "read" : "reads"}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button type="button" disabled={Boolean(busy) || !canCatalog} onClick={confirmBatch}>
                    {busy === "confirm" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                    Catalog next batch ({Math.min(Number(batchSize), previewRemaining)})
                  </Button>
                  {canPause || status === "paused" ? (
                    <Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={togglePaused}>
                      {busy === "pause"
                        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        : status === "paused"
                          ? <Play className="mr-2 h-4 w-4" />
                          : <Pause className="mr-2 h-4 w-4" />}
                      {status === "paused" ? "Resume catalog" : "Pause catalog"}
                    </Button>
                  ) : null}
                  {canCancel ? (
                    <Button type="button" variant="destructive" disabled={Boolean(busy)} onClick={cancelCampaign}>
                      {busy === "cancel" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
                      Cancel remaining
                    </Button>
                  ) : null}
                </div>

                <details className="rounded-md border">
                  <summary className="cursor-pointer p-3 text-sm font-medium">Advanced campaign details</summary>
                  <div className="space-y-3 border-t p-3 text-sm">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <div><span className="font-medium">{formatCount(counts.unavailable)}</span> unavailable</div>
                      <div><span className="font-medium">{formatCount(counts.invalid)}</span> invalid</div>
                      <div><span className="font-medium">{formatCount(counts.cancelled)}</span> cancelled</div>
                      <div><span className="font-medium">{formatCount(counts.retryable)}</span> retryable</div>
                    </div>
                    {overview.worker?.lastError ? (
                      <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
                        {workerErrorText(overview.worker.lastError)}
                      </p>
                    ) : null}
                    {retryCandidates.length ? (
                      <div className="space-y-2">
                        <div className="font-medium">Failures eligible for one bounded retry</div>
                        {retryCandidates.map((candidate) => (
                          <div key={candidate.jobId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                            <div>
                              <div className="font-medium">Read #{candidate.readId}</div>
                              <div className="text-xs text-muted-foreground">
                                {candidate.errorCode || "Catalog failure"} · {candidate.failureStage || "processing"} · {formatCount(candidate.operatorRetryCount)} operator retries
                              </div>
                            </div>
                            <Button type="button" size="sm" variant="outline" disabled={Boolean(busy) || !canRetryItems} onClick={() => retryJob(candidate.jobId)}>
                              {busy === `retry:${candidate.jobId}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                              Retry item
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </details>
              </div>
            ) : (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                Create a durable preview before any canonical image or read link can be written.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {canPreview ? (
                <Button type="button" onClick={startPreview} disabled={Boolean(busy)}>
                  {busy === "preview" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}
                  {run?.status === "completed" ? "Create delta preview" : "Create catalog preview"}
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={refresh} disabled={Boolean(busy)}>
                {busy === "refresh" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Refresh status
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <p>Canonical Overview catalog status is unavailable.</p>
            <Button type="button" variant="outline" onClick={refresh} disabled={Boolean(busy)}>
              {busy === "refresh" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Retry status
            </Button>
          </div>
        )}

        <div className="flex gap-3 rounded-md border p-3 text-sm">
          <Archive className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
          <div>
            <div className="font-medium">Archival retention</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Superseded and zero-link canonical assets are retained for rollback and review. This page has no asset deletion or cleanup control.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatCount(retention.zeroLinkAssetCount)} zero-link assets currently use {formatBytes(retention.zeroLinkAssetBytes)}.
            </p>
          </div>
          <HardDrive className="ml-auto mt-0.5 hidden h-4 w-4 flex-none text-muted-foreground sm:block" />
        </div>

        {message ? <p className="rounded-md border p-3 text-sm" role="status">{message}</p> : null}
      </CardContent>
    </Card>
  );
}
