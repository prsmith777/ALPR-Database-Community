"use client";

import NextImage from "next/image";
import { useState } from "react";
import { CheckCircle2, Layers3, Loader2, RefreshCw, Split } from "lucide-react";

import {
  analyzeRecentVehicleClusters,
  getVehicleClusterOverview,
  reviewVehicleClusterSuggestion,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function when(value) {
  return value ? new Date(value).toLocaleString() : "Unknown";
}

export default function VehicleClusters({ initialResult }) {
  const [result, setResult] = useState(initialResult);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const data = result?.success ? result.data : null;

  const reload = async () => {
    const next = await getVehicleClusterOverview();
    setResult(next);
    if (!next.success) throw new Error(next.error);
  };

  const analyze = async () => {
    setBusy("analyze");
    setMessage("");
    try {
      const response = await analyzeRecentVehicleClusters(100);
      if (!response.success) throw new Error(response.error);
      await reload();
      setMessage(`Clustered ${response.data.assigned} of ${response.data.processed} unassigned captures and evaluated color for ${response.data.attributes.processed} captures.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const review = async (readId, decision) => {
    setBusy(`${readId}:${decision}`);
    setMessage("");
    try {
      const response = await reviewVehicleClusterSuggestion({ readId, decision });
      if (!response.success) throw new Error(response.error);
      await reload();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  if (!data) return <div className="rounded-lg border border-destructive/30 p-4 text-destructive">{result?.error || "Unable to load vehicle clusters."}</div>;

  return (
    <div className="space-y-6">
      <Card className="border-blue-500/30 bg-blue-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Layers3 className="h-5 w-5" /> Shadow vehicle clustering</CardTitle>
          <CardDescription>
            Descriptor-only candidate groupings for human review. Plate text is not used in grouping, and this page does not create ownership claims or mismatch alerts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.totalClusters}</div><div className="text-xs text-muted-foreground">clusters</div></div>
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.shadowClusters}</div><div className="text-xs text-muted-foreground">shadow</div></div>
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.pendingReviews}</div><div className="text-xs text-muted-foreground">pending reviews</div></div>
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.confirmedAssignments}</div><div className="text-xs text-muted-foreground">confirmed assignments</div></div>
          </div>
          {data.canAnalyze && (
            <Button onClick={analyze} disabled={Boolean(busy)}>
              {busy === "analyze" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Analyze next 100 unassigned captures
            </Button>
          )}
          {message && <p className="rounded-md border bg-background p-3 text-sm">{message}</p>}
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div><h2 className="text-xl font-semibold">Vehicle review</h2><p className="text-sm text-muted-foreground">Confirm a suggested grouping or separate the capture into its own new shadow vehicle.</p></div>
        {data.suggestions.length === 0 ? (
          <div className="rounded-lg border p-6 text-sm text-muted-foreground">No vehicle suggestions are waiting for review.</div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {data.suggestions.map((suggestion) => (
              <Card key={suggestion.readId}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="text-base">Suggested Vehicle #{suggestion.clusterId}</CardTitle>
                    <Badge variant="outline">{Math.round(suggestion.similarity * 100)}% ReID</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div><div className="relative aspect-video overflow-hidden rounded-md bg-muted"><NextImage src={suggestion.candidateImageUrl} alt="Candidate vehicle" fill sizes="40vw" className="object-cover" unoptimized /></div><div className="mt-2 text-sm font-mono">{suggestion.candidatePlate}</div><div className="text-xs text-muted-foreground">New capture · {suggestion.candidateCamera}</div></div>
                    <div><div className="relative aspect-video overflow-hidden rounded-md bg-muted"><NextImage src={suggestion.representativeImageUrl} alt="Cluster representative vehicle" fill sizes="40vw" className="object-cover" unoptimized /></div><div className="mt-2 text-sm font-mono">{suggestion.representativePlate}</div><div className="text-xs text-muted-foreground">Current representative · {suggestion.representativeCamera}</div></div>
                  </div>
                  {data.canReview && (
                    <div className="grid grid-cols-2 gap-2">
                      <Button disabled={Boolean(busy)} onClick={() => review(suggestion.readId, "confirm")}>
                        {busy === `${suggestion.readId}:confirm` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />} Confirm vehicle
                      </Button>
                      <Button variant="outline" disabled={Boolean(busy)} onClick={() => review(suggestion.readId, "separate")}>
                        {busy === `${suggestion.readId}:separate` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Split className="mr-2 h-4 w-4" />} Different vehicle
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div><h2 className="text-xl font-semibold">Current shadow clusters</h2><p className="text-sm text-muted-foreground">Observed plates are review context only and do not affect cluster membership.</p></div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.clusters.map((cluster) => (
            <Card key={cluster.id} className="overflow-hidden">
              <div className="relative aspect-video bg-muted"><NextImage src={cluster.representativeImageUrl} alt={`Representative for Vehicle ${cluster.id}`} fill sizes="(min-width:1280px) 30vw, 50vw" className="object-cover" unoptimized /></div>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between"><div className="font-semibold">Vehicle #{cluster.id}</div><Badge variant="secondary">{cluster.status}</Badge></div>
                <div className="text-sm">{cluster.captureCount} captures · {cluster.confirmedCount} confirmed</div>
                {cluster.representativeColor && <div className="text-sm capitalize">{cluster.representativeColor} · {Math.round(cluster.representativeColorConfidence * 100)}% color</div>}
                <div className="text-xs text-muted-foreground">Last seen {when(cluster.lastSeen)}</div>
                <div className="flex flex-wrap gap-1">{cluster.observedPlates.slice(0, 5).map((plate) => <Badge key={plate} variant="outline" className="font-mono">{plate}</Badge>)}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
