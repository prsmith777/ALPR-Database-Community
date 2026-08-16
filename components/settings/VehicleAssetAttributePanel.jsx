"use client";

import { useEffect, useState } from "react";
import { BrainCircuit, Loader2, Pause, Play, RefreshCw, RotateCcw, XCircle } from "lucide-react";

import {
  cancelVehicleAssetAttributeCampaign,
  confirmVehicleAssetAttributeBatch,
  getVehicleAssetAttributeOverview,
  previewVehicleAssetAttributes,
  retryVehicleAssetAttributeJob,
  setVehicleAssetAttributePaused,
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

function overviewFrom(result) {
  if (!result?.success || !result.data?.overview) {
    throw new Error(result?.error || "Unable to load canonical crop attributes.");
  }
  return result.data.overview;
}

function Metric({ label, value }) {
  return (
    <div className="rounded-md border p-3 text-center">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export default function VehicleAssetAttributePanel({ initialOverview = null }) {
  const [overview, setOverview] = useState(initialOverview);
  const [batchSize, setBatchSize] = useState("5");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const run = overview?.latestRun || null;
  const catalog = overview?.catalog || {};
  const counts = run?.counts || {};
  const status = run?.status || "not_previewed";
  const active = count(counts.queued) + count(counts.processing) + count(counts.retryable);
  const total = count(counts.total);
  const previewFinished = Math.max(0, total - count(counts.pendingPreview) - count(counts.previewing));
  const attributeFinished = count(counts.ready) + count(counts.alreadyCurrent)
    + count(counts.sourceChanged) + count(counts.invalid) + count(counts.failed);
  const finished = status === "previewing" ? previewFinished : attributeFinished;
  const progress = total ? Math.min(100, Math.round(finished / total * 100)) : 0;
  const polling = status === "previewing" || (status === "running" && active > 0);
  const canPreview = !run || TERMINAL.has(status);
  const canObserve = ["ready", "running"].includes(status)
    && Boolean(run?.previewFingerprint) && count(counts.previewed) > 0 && active === 0;
  const canPause = ["ready", "running", "paused"].includes(status);
  const canCancel = ["previewing", "ready", "running", "paused"].includes(status)
    && count(counts.previewing) + count(counts.processing) === 0;

  useEffect(() => {
    if (!polling) return undefined;
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const next = overviewFrom(await getVehicleAssetAttributeOverview());
        if (!stopped) setOverview(next);
      } catch (error) {
        if (!stopped) setMessage(error.message);
      }
    }, 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [polling]);

  const perform = async (name, operation, successMessage) => {
    setBusy(name);
    setMessage("");
    try {
      const result = await operation();
      setOverview(overviewFrom(result));
      setMessage(typeof successMessage === "function" ? successMessage(result) : successMessage);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BrainCircuit className="h-5 w-5" /> Canonical crop attributes
            </CardTitle>
            <CardDescription className="mt-1 max-w-3xl">
              Evaluate each current identity-eligible canonical vehicle crop once for local color and body type.
            </CardDescription>
          </div>
          <Badge variant={status === "completed" ? "default" : "secondary"}>
            {status.replaceAll("_", " ")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-sm">
          <div className="font-medium">Provider-neutral local evidence</div>
          <p className="mt-1 text-xs text-muted-foreground">
            This creates immutable crop-owned observations in PostgreSQL. Unknown nighttime or monochrome results remain valid evidence. It does not replace current read attributes or ReID, alter vehicle assignments, call Plate Recognizer, or send data outside ALPR.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <Metric label="eligible current crops" value={count(catalog.eligibleCrops).toLocaleString()} />
          <Metric label="fully observed crops" value={count(catalog.fullyObservedCrops).toLocaleString()} />
          <Metric label="observation rows" value={count(catalog.observationCount).toLocaleString()} />
          <Metric label="color ready" value={count(catalog.colorReady).toLocaleString()} />
          <Metric label="color unknown" value={count(catalog.colorUnknown).toLocaleString()} />
          <Metric label="body type ready" value={count(catalog.bodyTypeReady).toLocaleString()} />
          <Metric label="body type unknown" value={count(catalog.bodyTypeUnknown).toLocaleString()} />
        </div>

        {run ? (
          <div className="space-y-4 rounded-md border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-medium">Attribute campaign #{run.id}</div>
                <div className="text-xs text-muted-foreground">
                  Frozen through crop derivative #{count(run.maxDerivativeId).toLocaleString()} · {run.algorithmVersion}
                </div>
              </div>
              <Badge variant="outline">{count(counts.previewed).toLocaleString()} ready for a batch</Badge>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="campaign crops" value={total.toLocaleString()} />
              <Metric label="previewed" value={count(counts.previewed).toLocaleString()} />
              <Metric label="queued" value={count(counts.queued).toLocaleString()} />
              <Metric label="processing" value={count(counts.processing).toLocaleString()} />
              <Metric label="observed" value={(count(counts.ready) + count(counts.alreadyCurrent)).toLocaleString()} />
              <Metric label="exceptions" value={(count(counts.sourceChanged) + count(counts.invalid) + count(counts.failed)).toLocaleString()} />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{finished.toLocaleString()} of {total.toLocaleString()} inspected or terminal</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} aria-label={`${progress}% of canonical crop attribute campaign complete`} />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[9rem] space-y-2">
                <Label>Next batch</Label>
                <Select value={batchSize} onValueChange={setBatchSize}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BATCH_SIZES.map((size) => (
                      <SelectItem key={size} value={String(size)}>{size} crop{size === 1 ? "" : "s"}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                disabled={Boolean(busy) || !canObserve}
                onClick={() => perform("confirm", () => confirmVehicleAssetAttributeBatch({
                  runId: run.id,
                  previewFingerprint: run.previewFingerprint,
                  limit: Number(batchSize),
                }), (result) => `Queued ${count(result.data?.confirmation?.queued).toLocaleString()} crop attribute(s).`)}
              >
                {busy === "confirm" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                Evaluate next batch ({Math.min(Number(batchSize), count(counts.previewed))})
              </Button>
              <Button
                variant="secondary"
                disabled={Boolean(busy) || !canPause}
                onClick={() => perform("pause", () => setVehicleAssetAttributePaused({
                  runId: run.id, paused: status !== "paused",
                }), status === "paused" ? "Crop attribute resumed." : "Crop attribute paused.")}
              >
                {status === "paused" ? <Play className="mr-2 h-4 w-4" /> : <Pause className="mr-2 h-4 w-4" />}
                {status === "paused" ? "Resume" : "Pause"}
              </Button>
              <Button
                variant="destructive"
                disabled={Boolean(busy) || !canCancel}
                onClick={() => perform("cancel", () => cancelVehicleAssetAttributeCampaign({ runId: run.id }),
                  "Remaining crop attribute work was cancelled; completed attributes were preserved.")}
              >
                <XCircle className="mr-2 h-4 w-4" />Cancel remaining
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button
            disabled={Boolean(busy) || !canPreview}
            onClick={() => perform("preview", previewVehicleAssetAttributes,
              "Attribute preview started. Local color and body-type evaluation runs, but no observation rows are stored until a batch is confirmed.")}
          >
            {busy === "preview" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BrainCircuit className="mr-2 h-4 w-4" />}
            {run ? "Create delta attribute preview" : "Create attribute preview"}
          </Button>
          <Button
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => perform("refresh", getVehicleAssetAttributeOverview, "Attribute status refreshed.")}
          >
            <RefreshCw className="mr-2 h-4 w-4" />Refresh status
          </Button>
        </div>

        {overview?.retryCandidates?.length ? (
          <details className="rounded-md border p-4">
            <summary className="cursor-pointer text-sm font-medium">Retryable failures</summary>
            <div className="mt-3 space-y-2">
              {overview.retryCandidates.map((item) => (
                <div key={item.jobId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                  <span>Crop #{item.derivativeId}: {item.errorCode}{item.errorMessage ? ` · ${item.errorMessage}` : ""}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy) || item.operatorRetryCount >= 1}
                    onClick={() => perform(`retry:${item.jobId}`,
                      () => retryVehicleAssetAttributeJob({ jobId: item.jobId }),
                      "The crop attribute was queued for its one bounded operator retry.")}
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />Retry once
                  </Button>
                </div>
              ))}
            </div>
          </details>
        ) : null}

        {message ? <p className="rounded-md border p-3 text-sm">{message}</p> : null}
      </CardContent>
    </Card>
  );
}

