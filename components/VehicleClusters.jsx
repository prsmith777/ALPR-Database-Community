"use client";

import NextImage from "next/image";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, CheckCircle2, Layers3, Loader2, RefreshCw, Split } from "lucide-react";

import {
  analyzeRecentVehicleClusters,
  getVehicleClusterOverview,
  reviewVehicleClusterSuggestion,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function when(value) {
  return value ? new Date(value).toLocaleString() : "Unknown";
}

export default function VehicleClusters({ initialResult }) {
  const [result, setResult] = useState(initialResult);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [featureFilter, setFeatureFilter] = useState("all");
  const data = result?.success ? result.data : null;

  const reload = async (nextFeatureFilter = featureFilter) => {
    const next = await getVehicleClusterOverview(nextFeatureFilter === "all" ? null : nextFeatureFilter);
    setResult(next);
    if (!next.success) throw new Error(next.error);
  };

  const changeFeatureFilter = async (value) => {
    setFeatureFilter(value);
    setBusy("filter");
    setMessage("");
    try { await reload(value); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
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
          <CardTitle className="flex items-center gap-2"><Layers3 className="h-5 w-5" /> Vehicle identity foundation</CardTitle>
          <CardDescription>
            ReID groups captures without using plate text. Confirmed plate associations are reviewed separately and form the trusted baseline for future mismatch detection.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.totalClusters}</div><div className="text-xs text-muted-foreground">clusters</div></div>
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.shadowClusters}</div><div className="text-xs text-muted-foreground">shadow</div></div>
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.confirmedProfiles}</div><div className="text-xs text-muted-foreground">confirmed profiles</div></div>
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.pendingReviews}</div><div className="text-xs text-muted-foreground">pending reviews</div></div>
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.confirmedAssignments}</div><div className="text-xs text-muted-foreground">confirmed assignments</div></div>
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.pendingPlateAssociations}</div><div className="text-xs text-muted-foreground">plate links to review</div></div>
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
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div><h2 className="text-xl font-semibold">Vehicle profiles</h2><p className="text-sm text-muted-foreground">Open a vehicle to review its captures, distinguishing features, and effective-plate associations. Plate text never affects ReID grouping.</p></div>
          <Select value={featureFilter} onValueChange={changeFeatureFilter} disabled={busy === "filter"}>
            <SelectTrigger className="w-full sm:w-64" aria-label="Filter vehicle profiles by distinctive feature"><SelectValue placeholder="All distinctive features" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All distinctive features</SelectItem>
              {data.featureCatalog.map((feature) => <SelectItem key={feature.key} value={feature.key}>{feature.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.clusters.map((cluster) => (
            <Card key={cluster.id} className="overflow-hidden">
              <div className="relative aspect-video bg-muted"><NextImage src={cluster.representativeImageUrl} alt={`Representative for Vehicle ${cluster.id}`} fill sizes="(min-width:1280px) 30vw, 50vw" className="object-cover" unoptimized /></div>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between"><div className="font-semibold">Vehicle #{cluster.id}</div><Badge variant="secondary">{cluster.status}</Badge></div>
                <div className="text-sm">{cluster.captureCount} captures · {cluster.confirmedCount} confirmed</div>
                {cluster.representativeColor && <div className="text-sm capitalize">{cluster.representativeColor} · {Math.round(cluster.representativeColorConfidence * 100)}% color</div>}
                <div className="text-xs text-muted-foreground">Last seen {when(cluster.lastSeen)}</div>
                {cluster.confirmedPlateAssociations.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">Confirmed plates</div>
                    <div className="flex flex-wrap gap-1">{cluster.confirmedPlateAssociations.map((association) => <Badge key={association.plateNumber} className="font-mono">{association.plateNumber}</Badge>)}</div>
                  </div>
                )}
                {cluster.suggestedPlateAssociations.length > 0 && <div className="text-xs text-amber-600 dark:text-amber-400">{cluster.suggestedPlateAssociations.length} plate association{cluster.suggestedPlateAssociations.length === 1 ? "" : "s"} awaiting review</div>}
                {cluster.distinctiveFeatures.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">Distinctive features</div>
                    <div className="flex flex-wrap gap-1">{cluster.distinctiveFeatures.map((feature) => <Badge key={feature.key} variant="secondary">{feature.label} · {feature.captureCount}</Badge>)}</div>
                  </div>
                )}
                <div className="flex flex-wrap gap-1">{cluster.observedPlates.slice(0, 5).map((plate) => <Badge key={plate} variant="outline" className="font-mono">{plate}</Badge>)}</div>
                <Button asChild variant="outline" className="w-full"><Link href={`/visual_search/vehicles/${cluster.id}`}>Open vehicle profile <ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
              </CardContent>
            </Card>
          ))}
        </div>
        {data.clusters.length === 0 && <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No vehicle profiles contain that reviewed feature yet.</div>}
      </section>
    </div>
  );
}
