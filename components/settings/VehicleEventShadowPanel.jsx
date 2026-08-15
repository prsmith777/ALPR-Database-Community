"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { GitMerge, Loader2, Pause, Play, RefreshCw } from "lucide-react";

import {
  getVehicleEventShadowOverview,
  runVehicleEventShadowBatch,
  setVehicleEventShadowEnabled,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function count(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function formatDateTime(value) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not yet";
}

function Metric({ label, value }) {
  return (
    <div className="rounded-md border p-3 text-center">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export default function VehicleEventShadowPanel({ initialOverview = null }) {
  const [overview, setOverview] = useState(initialOverview);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const enabled = overview?.control?.enabled === true;
  const counts = overview?.counts || {};

  async function refresh({ quiet = false } = {}) {
    if (!quiet) setBusy("refresh");
    const result = await getVehicleEventShadowOverview();
    if (result?.success) {
      setOverview(result.data.overview);
      if (!quiet) setMessage("");
    } else if (!quiet) {
      setMessage(result?.error || "Unable to refresh shadow vehicle events.");
    }
    if (!quiet) setBusy("");
  }

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(() => refresh({ quiet: true }), 5000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  async function toggleEnabled() {
    setBusy("toggle");
    setMessage("");
    const result = await setVehicleEventShadowEnabled({ enabled: !enabled });
    if (result?.success) {
      setOverview(result.data.overview);
      setMessage(!enabled
        ? "Shadow vehicle-event correlation is active. It writes review evidence only."
        : "Shadow vehicle-event correlation is disabled.");
    } else {
      setMessage(result?.error || "Unable to update shadow vehicle-event correlation.");
    }
    setBusy("");
  }

  async function runBatch() {
    setBusy("batch");
    setMessage("");
    const result = await runVehicleEventShadowBatch();
    if (result?.success) {
      setOverview(result.data.overview);
      const batch = result.data.result || {};
      setMessage(
        `Processed ${count(batch.processed).toLocaleString()}: `
        + `${count(batch.proposed).toLocaleString()} proposed, `
        + `${count(batch.rejected).toLocaleString()} rejected, `
        + `${count(batch.retired).toLocaleString()} retired.`
      );
    } else {
      setMessage(result?.error || "Unable to run the shadow event batch.");
    }
    setBusy("");
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <GitMerge className="h-5 w-5" /> Shadow vehicle events
            </CardTitle>
            <CardDescription className="mt-2 max-w-4xl">
              Correlates two current canonical Overview observations only when their context,
              exact effective plate, different LPR cameras, direction evidence, and bounded
              timing agree. Ambiguous evidence fails closed.
            </CardDescription>
          </div>
          <Badge variant={enabled ? "default" : "secondary"}>
            {enabled ? "Active · shadow only" : "Disabled"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <Metric label="eligible observations" value={count(counts.eligibleObservations).toLocaleString()} />
          <Metric label="not in a pair" value={count(counts.unpairedObservations).toLocaleString()} />
          <Metric label="shadow events" value={count(counts.activeEvents).toLocaleString()} />
          <Metric label="correlated reads" value={count(counts.correlatedReads).toLocaleString()} />
          <Metric label="shared-image pairs" value={count(counts.sharedAssetEvents).toLocaleString()} />
          <Metric label="timed pairs" value={count(counts.timedPairEvents).toLocaleString()} />
          <Metric label="retired events" value={count(counts.retiredEvents).toLocaleString()} />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={toggleEnabled} disabled={Boolean(busy)}>
            {busy === "toggle" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : enabled ? <Pause className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}
            {enabled ? "Disable shadow correlation" : "Enable shadow correlation"}
          </Button>
          <Button variant="secondary" onClick={runBatch} disabled={Boolean(busy) || !enabled}>
            {busy === "batch" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <Play className="mr-2 h-4 w-4" />}
            Run one shadow batch now
          </Button>
          <Button variant="outline" onClick={() => refresh()} disabled={Boolean(busy)}>
            {busy === "refresh" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh status
          </Button>
        </div>

        {message ? <p className="rounded-md border p-3 text-sm">{message}</p> : null}

        <div className="rounded-md border p-4 text-sm">
          <div className="font-medium">Strictly isolated shadow evidence</div>
          <p className="mt-1 text-muted-foreground">
            These events do not replace plate reads, Vehicle Views, current ReID, clusters,
            attributes, or notifications. Entry-to-Street display fallbacks are excluded,
            and no Plate Recognizer or other external provider is contacted.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Settle delay: {count(overview?.control?.settleSeconds).toLocaleString()} seconds ·
            worker batch: {count(overview?.control?.batchSize).toLocaleString()} · last event: {formatDateTime(counts.lastEventAt)}
          </p>
        </div>

        <details className="rounded-md border">
          <summary className="cursor-pointer p-4 font-medium">
            Recent shadow decisions ({count(counts.rejectedDecisions).toLocaleString()} rejected total)
          </summary>
          <div className="space-y-2 border-t p-4">
            {(overview?.recentDecisions || []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No shadow decisions have been recorded.</p>
            ) : overview.recentDecisions.map((decision) => (
              <div key={decision.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border p-3 text-sm">
                <Badge variant={decision.outcome === "proposed" ? "default" : "secondary"}>
                  {decision.outcome}
                </Badge>
                <span>{decision.reason}</span>
                <span className="text-muted-foreground">{decision.overviewContext}</span>
                <Link className="text-primary underline" href={`/live_feed?readId=${decision.anchorReadId}`}>
                  read #{decision.anchorReadId}
                </Link>
                {decision.companionReadId ? (
                  <Link className="text-primary underline" href={`/live_feed?readId=${decision.companionReadId}`}>
                    paired with #{decision.companionReadId}
                  </Link>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(decision.createdAt)}</span>
              </div>
            ))}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
