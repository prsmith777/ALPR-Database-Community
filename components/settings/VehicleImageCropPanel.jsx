"use client";

import { useEffect, useState } from "react";
import { Crop, Loader2, Pause, Play, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import NextImage from "next/image";

import {
  cancelVehicleImageCropCampaign,
  confirmVehicleImageCropBatch,
  getVehicleImageCropOverview,
  previewVehicleImageCrops,
  retryVehicleImageCropJob,
  retryVehicleImageCropLiveJob,
  setVehicleImageCropLiveEnabled,
  setVehicleImageCropPaused,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const BATCH_SIZES = Object.freeze([1, 5, 25, 250]);
const TERMINAL = new Set(["completed", "cancelled", "failed"]);

function count(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function formatBytes(value) {
  let bytes = count(value);
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let unit = 0;
  bytes /= 1024;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit += 1;
  }
  return `${bytes.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function overviewFrom(result) {
  if (!result?.success || !result.data?.overview) {
    throw new Error(result?.error || "Unable to load canonical Overview vehicle crops.");
  }
  return result.data.overview;
}

function Metric({ label, value, detail = null }) {
  return (
    <div className="rounded-md border p-3 text-center">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {detail ? <div className="mt-1 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

export default function VehicleImageCropPanel({ initialOverview = null }) {
  const [overview, setOverview] = useState(initialOverview);
  const [batchSize, setBatchSize] = useState("5");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const run = overview?.latestRun || null;
  const catalog = overview?.catalog || {};
  const counts = run?.counts || {};
  const live = overview?.live || {};
  const liveCounts = live.counts || {};
  const status = run?.status || "not_previewed";
  const active = count(counts.queued) + count(counts.processing) + count(counts.retryable);
  const total = count(counts.total);
  const previewFinished = Math.max(0, total - count(counts.pendingPreview) - count(counts.previewing));
  const catalogFinished = count(counts.ready) + count(counts.alreadyCurrent)
    + count(counts.sourceChanged) + count(counts.invalid) + count(counts.failed);
  const finished = status === "previewing" ? previewFinished : catalogFinished;
  const progress = total ? Math.min(100, Math.round(finished / total * 100)) : 0;
  const pixelReduction = count(counts.sourcePixels)
    ? Math.max(0, 100 - Math.round(count(counts.cropPixels) / count(counts.sourcePixels) * 100))
    : 0;
  const liveActive = count(liveCounts.queued) + count(liveCounts.processing)
    + count(liveCounts.retryable);
  const polling = status === "previewing" || (status === "running" && active > 0)
    || (live.enabled === true && (count(liveCounts.pendingEligible) > 0 || liveActive > 0));
  const canPreview = (!run || TERMINAL.has(status)) && live.enabled !== true;
  const canCatalog = ["ready", "running"].includes(status)
    && Boolean(run?.previewFingerprint)
    && count(counts.previewed) > 0 && active === 0;
  const canPause = ["ready", "running", "paused"].includes(status);
  const canCancel = ["previewing", "ready", "running", "paused"].includes(status)
    && count(counts.previewing) + count(counts.processing) === 0;

  const refresh = async () => {
    setBusy("refresh");
    setMessage("");
    try { setOverview(overviewFrom(await getVehicleImageCropOverview())); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  useEffect(() => {
    if (!polling) return undefined;
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const next = overviewFrom(await getVehicleImageCropOverview());
        if (!stopped) setOverview(next);
      } catch (error) {
        if (!stopped) setMessage(error.message);
      }
    }, 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [polling]);

  const startPreview = async () => {
    setBusy("preview"); setMessage("");
    try {
      setOverview(overviewFrom(await previewVehicleImageCrops()));
      setMessage("Crop preview started. It reads and encodes locally but writes no crop files.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const confirmBatch = async () => {
    setBusy("confirm"); setMessage("");
    try {
      const result = await confirmVehicleImageCropBatch({
        runId: run.id,
        previewFingerprint: run.previewFingerprint,
        limit: Number(batchSize),
      });
      setOverview(overviewFrom(result));
      setMessage(`Queued ${count(result.data?.confirmation?.queued).toLocaleString()} vehicle crop(s).`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const togglePause = async () => {
    const paused = status !== "paused";
    setBusy("pause"); setMessage("");
    try {
      setOverview(overviewFrom(await setVehicleImageCropPaused({ runId: run.id, paused })));
      setMessage(paused ? "Vehicle crop batches are paused." : "Vehicle crop batches resumed.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const cancel = async () => {
    setBusy("cancel"); setMessage("");
    try {
      setOverview(overviewFrom(await cancelVehicleImageCropCampaign({ runId: run.id })));
      setMessage("Remaining vehicle crop work was cancelled; completed crops were preserved.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const retry = async (jobId) => {
    setBusy(`retry:${jobId}`); setMessage("");
    try {
      setOverview(overviewFrom(await retryVehicleImageCropJob({ jobId })));
      setMessage("Vehicle crop item was queued for its one bounded operator retry.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const toggleLive = async () => {
    const enabled = live.enabled !== true;
    setBusy("live-toggle"); setMessage("");
    try {
      setOverview(overviewFrom(await setVehicleImageCropLiveEnabled({ enabled })));
      setMessage(enabled
        ? "Automatic local cropping is enabled. New identity-eligible canonical assets will be cropped one at a time."
        : "Automatic cropping is disabled. An item already being written may finish; no new work will be claimed.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const retryLive = async (jobId) => {
    setBusy(`live-retry:${jobId}`); setMessage("");
    try {
      setOverview(overviewFrom(await retryVehicleImageCropLiveJob({ jobId })));
      setMessage("The automatic crop failure was queued for its one bounded operator retry.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Crop className="h-5 w-5" /> Canonical Overview vehicle crops
            </CardTitle>
            <CardDescription className="mt-1 max-w-3xl">
              Create one padded whole-vehicle JPEG for each unique identity-eligible canonical Overview asset. Shared reads reuse the same crop.
            </CardDescription>
          </div>
          <Badge variant={status === "completed" ? "default" : "secondary"}>
            {status.replaceAll("_", " ")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-sm">
          <div className="font-medium">Local derivative only</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Full Overview JPEGs are retained. Crops add storage and prepare asset-owned ReID v2; they do not change current ReID, attributes, events, notifications, or contact Plate Recognizer.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="eligible assets" value={count(catalog.eligibleAssets).toLocaleString()} />
          <Metric label="completed crops" value={count(catalog.cropCount).toLocaleString()} />
          <Metric label="physical crop files" value={count(catalog.physicalFiles).toLocaleString()} />
          <Metric label="crop storage" value={formatBytes(catalog.cropBytes)} />
        </div>

        {run ? (
          <div className="space-y-4 rounded-md border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-medium">Crop campaign #{run.id}</div>
                <div className="text-xs text-muted-foreground">
                  Frozen through canonical asset #{count(run.maxAssetId).toLocaleString()}
                </div>
              </div>
              <Badge variant="outline">{count(counts.previewed).toLocaleString()} ready for a batch</Badge>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="campaign assets" value={total.toLocaleString()} />
              <Metric label="unique crop bytes" value={formatBytes(counts.projectedBytes)} />
              <Metric label="pixel area removed" value={`${pixelReduction}%`} />
              <Metric label="queued" value={count(counts.queued).toLocaleString()} />
              <Metric label="completed" value={(count(counts.ready) + count(counts.alreadyCurrent)).toLocaleString()} />
              <Metric label="exceptions" value={(count(counts.sourceChanged) + count(counts.invalid) + count(counts.failed)).toLocaleString()} />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{finished.toLocaleString()} of {total.toLocaleString()} inspected or terminal</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} aria-label={`${progress}% of canonical Overview crop campaign complete`} />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[9rem] space-y-2">
                <Label>Next batch</Label>
                <Select value={batchSize} onValueChange={setBatchSize}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BATCH_SIZES.map((size) => (
                      <SelectItem key={size} value={String(size)}>{size} asset{size === 1 ? "" : "s"}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={confirmBatch} disabled={Boolean(busy) || !canCatalog}>
                {busy === "confirm" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                Create next batch ({Math.min(Number(batchSize), count(counts.previewed))})
              </Button>
              <Button variant="secondary" onClick={togglePause} disabled={Boolean(busy) || !canPause}>
                {status === "paused" ? <Play className="mr-2 h-4 w-4" /> : <Pause className="mr-2 h-4 w-4" />}
                {status === "paused" ? "Resume" : "Pause"}
              </Button>
              <Button variant="destructive" onClick={cancel} disabled={Boolean(busy) || !canCancel}>
                <XCircle className="mr-2 h-4 w-4" />Cancel remaining
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button onClick={startPreview} disabled={Boolean(busy) || !canPreview}>
            {busy === "preview" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Crop className="mr-2 h-4 w-4" />}
            {run ? "Create delta crop preview" : "Create crop preview"}
          </Button>
          <Button variant="outline" onClick={refresh} disabled={Boolean(busy)}>
            <RefreshCw className="mr-2 h-4 w-4" />Refresh status
          </Button>
        </div>

        <div className="space-y-4 rounded-md border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-medium">Automatic new canonical vehicle cropping</div>
              <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                After the inspected campaign, a durable low-priority worker crops newly cataloged identity assets one at a time. It reuses the same exact source checks and never blocks Vehicle Views, changes ReID, or calls an external provider.
              </p>
            </div>
            <Badge variant={live.enabled ? "default" : "secondary"}>
              {live.enabled ? live.state?.replaceAll("_", " ") : "disabled"}
            </Badge>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="awaiting current crop" value={count(liveCounts.pendingEligible).toLocaleString()} />
            <Metric label="queued" value={count(liveCounts.queued).toLocaleString()} />
            <Metric label="processing" value={count(liveCounts.processing).toLocaleString()} />
            <Metric label="cropped automatically" value={(count(liveCounts.ready) + count(liveCounts.alreadyCurrent)).toLocaleString()} />
            <Metric
              label="exceptions"
              value={(count(liveCounts.sourceChanged) + count(liveCounts.unavailable)
                + count(liveCounts.invalid) + count(liveCounts.failed)).toLocaleString()}
              detail={`${count(liveCounts.sourceChanged).toLocaleString()} source changed`}
            />
            <Metric
              label="last automatic crop"
              value={liveCounts.lastCompletedAt
                ? new Date(liveCounts.lastCompletedAt).toLocaleString()
                : "Not yet"}
            />
          </div>
          <Button onClick={toggleLive} disabled={Boolean(busy)} variant={live.enabled ? "secondary" : "default"}>
            {busy === "live-toggle"
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : live.enabled
                ? <Pause className="mr-2 h-4 w-4" />
                : <Play className="mr-2 h-4 w-4" />}
            {live.enabled ? "Disable automatic cropping" : "Enable automatic cropping"}
          </Button>
          {live.enabled ? (
            <p className="text-xs text-muted-foreground">
              Disable automatic cropping before creating another operator delta crop preview.
            </p>
          ) : null}
        </div>

        {(live.retryCandidates || []).length ? (
          <details className="rounded-md border">
            <summary className="cursor-pointer p-4 font-medium">Advanced automatic crop exceptions</summary>
            <div className="space-y-2 border-t p-4">
              {live.retryCandidates.map((item) => (
                <div key={item.jobId} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                  <span>Asset #{item.assetId}</span>
                  <Badge variant="secondary">{item.errorCode}</Badge>
                  <Button size="sm" variant="outline" className="ml-auto"
                    disabled={Boolean(busy) || item.operatorRetryCount >= 1}
                    onClick={() => retryLive(item.jobId)}>
                    <RotateCcw className="mr-2 h-4 w-4" />Retry once
                  </Button>
                </div>
              ))}
            </div>
          </details>
        ) : null}

        {(overview?.retryCandidates || []).length ? (
          <details className="rounded-md border">
            <summary className="cursor-pointer p-4 font-medium">Advanced crop exceptions</summary>
            <div className="space-y-2 border-t p-4">
              {overview.retryCandidates.map((item) => (
                <div key={item.jobId} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                  <span>Asset #{item.assetId}</span>
                  <Badge variant="secondary">{item.errorCode}</Badge>
                  <Button size="sm" variant="outline" className="ml-auto"
                    disabled={Boolean(busy) || item.operatorRetryCount >= 1}
                    onClick={() => retry(item.jobId)}>
                    <RotateCcw className="mr-2 h-4 w-4" />Retry once
                  </Button>
                </div>
              ))}
            </div>
          </details>
        ) : null}

        {(overview?.samples || []).length ? (
          <div className="space-y-3 rounded-md border p-4">
            <div>
              <div className="font-medium">Recent canonical crops</div>
              <p className="text-xs text-muted-foreground">
                Inspect each canary here before creating a larger batch. These are crop derivatives; the full Overview images remain retained.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {overview.samples.map((sample) => (
                <div key={`${sample.assetId}:${sample.imageUrl}`} className="overflow-hidden rounded-md border bg-black">
                  <div className="relative aspect-video">
                    <NextImage
                      src={sample.imageUrl}
                      alt={`Canonical vehicle crop for asset ${sample.assetId}`}
                      fill
                      sizes="(min-width: 1024px) 20vw, (min-width: 640px) 45vw, 90vw"
                      className="object-contain"
                      unoptimized
                    />
                  </div>
                  <div className="bg-background p-2 text-xs text-muted-foreground">
                    Asset #{sample.assetId} · {sample.width}×{sample.height}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {message ? <p className="rounded-md border p-3 text-sm">{message}</p> : null}
      </CardContent>
    </Card>
  );
}
