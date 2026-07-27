"use client";

import NextImage from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Compass,
  Gauge,
  Layers3,
  Loader2,
  RefreshCw,
  Search,
  Split,
} from "lucide-react";

import {
  analyzeRecentVehicleClusters,
  getVehicleClusterOverview,
  reviewVehicleClusterSuggestion,
  reviewVehicleDirection,
  reviewVehiclePlateAssociation,
} from "@/app/actions";
import { AssociationDecision } from "@/components/VehicleProfile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function when(value) {
  return value ? new Date(value).toLocaleString() : "Unknown";
}

function percent(value) {
  return value === null || value === undefined ? "Not scored" : `${Math.round(value * 100)}%`;
}

function PaginationControls({ pagination, onPageChange }) {
  if (!pagination || pagination.total === 0) return null;
  const first = (pagination.page - 1) * pagination.pageSize + 1;
  const last = Math.min(pagination.total, pagination.page * pagination.pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm">
      <span>Showing {first.toLocaleString()}–{last.toLocaleString()} of {pagination.total.toLocaleString()}</span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)}>
          <ChevronLeft className="mr-1 h-4 w-4" /> Previous
        </Button>
        <span className="min-w-24 text-center tabular-nums">Page {pagination.page} of {pagination.totalPages}</span>
        <Button variant="outline" size="sm" disabled={pagination.page >= pagination.totalPages} onClick={() => onPageChange(pagination.page + 1)}>
          Next <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function EmptyReview({ children }) {
  return <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">{children}</div>;
}

function AttentionSummary({ data }) {
  const direction = data.attention?.direction || [];
  const detector = data.attention?.detector || [];
  if (!direction.length && !detector.length) return null;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold">Camera setup needs attention</h2>
        <p className="text-sm text-muted-foreground">These are configuration tasks, not per-capture review decisions.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {direction.map((camera) => (
          <Card key={`direction:${camera.cameraName}`}>
            <CardContent className="flex items-start justify-between gap-4 p-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-medium"><Compass className="h-4 w-4" />{camera.cameraName}</div>
                <p className="text-sm text-muted-foreground">
                  {!camera.configured
                    ? "Front and rear direction meanings are incomplete."
                    : !camera.enabled
                      ? "Direction classification is paused."
                      : `Needs more examples: ${camera.frontCount} front and ${camera.rearCount} rear.`}
                </p>
              </div>
              <Button asChild variant="outline" size="sm"><Link href="/settings/vehicle-intelligence">Open setup</Link></Button>
            </CardContent>
          </Card>
        ))}
        {detector.map((camera) => (
          <Card key={`detector:${camera.cameraName}`}>
            <CardContent className="flex items-start justify-between gap-4 p-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-medium"><Camera className="h-4 w-4" />{camera.cameraName}</div>
                <p className="text-sm text-muted-foreground">
                  Vehicle detection succeeded on {camera.detectionStats.successRate}% of {camera.detectionStats.indexedCount} indexed captures. Review fallback framing.
                </p>
              </div>
              <Button asChild variant="outline" size="sm"><Link href="/visual_search">Review camera</Link></Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

export default function VehicleClusters({ initialResult, view = "profiles", initialQueue = "vehicle" }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [result, setResult] = useState(initialResult);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [profileSearch, setProfileSearch] = useState(initialResult?.data?.filters?.profileSearch || "");
  const data = result?.success ? result.data : null;
  const basePath = view === "review" ? "/visual_search/vehicles/review" : "/visual_search/vehicles";
  const activeQueue = ["vehicle", "plates", "direction", "setup"].includes(initialQueue)
    ? initialQueue
    : "vehicle";

  useEffect(() => {
    setResult(initialResult);
    setProfileSearch(initialResult?.data?.filters?.profileSearch || "");
  }, [initialResult]);

  const options = (overrides = {}) => ({
    profilePage: data?.pagination?.profiles?.page || 1,
    vehicleReviewPage: data?.pagination?.vehicleReviews?.page || 1,
    plateReviewPage: data?.pagination?.plateReviews?.page || 1,
    directionReviewPage: data?.pagination?.directionReviews?.page || 1,
    profileStatus: data?.filters?.profileStatus || null,
    profileSearch: data?.filters?.profileSearch || null,
    profileCamera: data?.filters?.profileCamera || null,
    ...overrides,
  });

  const reload = async (overrides = {}) => {
    const next = await getVehicleClusterOverview(options(overrides));
    setResult(next);
    if (!next.success) throw new Error(next.error);
    router.refresh();
    return next.data;
  };

  const updateUrl = (updates) => {
    const parameters = new URLSearchParams(searchParams.toString());
    Object.entries(updates).forEach(([key, value]) => {
      if (value === null || value === undefined || value === "" || value === 1 || value === "all") parameters.delete(key);
      else parameters.set(key, String(value));
    });
    const query = parameters.toString();
    router.push(query ? `${basePath}?${query}` : basePath);
  };

  const page = (urlKey, value) => updateUrl({ [urlKey]: value });

  const clampReviewPage = (next, paginationKey, urlKey) => {
    const pagination = next.pagination[paginationKey];
    if (pagination.page > pagination.totalPages) updateUrl({ [urlKey]: pagination.totalPages });
  };

  const analyze = async () => {
    setBusy("analyze");
    setMessage("");
    try {
      const response = await analyzeRecentVehicleClusters(100);
      if (!response.success) throw new Error(response.error);
      await reload({ profilePage: 1, vehicleReviewPage: 1, plateReviewPage: 1, directionReviewPage: 1 });
      setMessage(`Clustered ${response.data.assigned} of ${response.data.processed} unassigned captures and evaluated color for ${response.data.attributes.processed} captures.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const reviewCluster = async (readId, decision) => {
    setBusy(`cluster:${readId}:${decision}`);
    setMessage("");
    try {
      const response = await reviewVehicleClusterSuggestion({ readId, decision });
      if (!response.success) throw new Error(response.error);
      const next = await reload();
      clampReviewPage(next, "vehicleReviews", "vehicleReviewPage");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const reviewAssociation = async (clusterId, plateNumber, decision) => {
    setBusy(`${plateNumber}:${decision}`);
    setMessage("");
    try {
      const response = await reviewVehiclePlateAssociation({ clusterId, plateNumber, decision });
      if (!response.success) throw new Error(response.error);
      const next = await reload();
      clampReviewPage(next, "plateReviews", "plateReviewPage");
      setMessage(decision === "confirm"
        ? `${plateNumber} is now a confirmed vehicle association.`
        : `${plateNumber} was rejected for Vehicle #${clusterId}.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const reviewDirection = async (readId, orientation) => {
    setBusy(`direction:${readId}:${orientation}`);
    setMessage("");
    try {
      const response = await reviewVehicleDirection({ readId, orientation });
      if (!response.success) throw new Error(response.error);
      const next = await reload();
      clampReviewPage(next, "directionReviews", "directionReviewPage");
      setMessage(`Saved this capture as a ${orientation} view and updated its camera calibration.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const applyFilters = () => updateUrl({
    profileSearch: profileSearch.trim(),
    profileStatus: data.filters.profileStatus || "all",
    profileCamera: data.filters.profileCamera || "all",
    profilesPage: 1,
  });

  const setFilter = (key, value) => {
    const urlKey = key === "profileStatus" ? "profileStatus" : "profileCamera";
    updateUrl({ [urlKey]: value, profilesPage: 1 });
  };

  if (!data) return <div className="rounded-lg border border-destructive/30 p-4 text-destructive">{result?.error || "Unable to load vehicle clusters."}</div>;

  return (
    <div className="space-y-8">
      {view === "profiles" && <Card className="border-blue-500/30 bg-blue-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Layers3 className="h-5 w-5" /> Vehicle identity foundation</CardTitle>
          <CardDescription>
            ReID groups captures without using plate text. Outstanding decisions are organized in the Needs Review tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.totalClusters}</div><div className="text-xs text-muted-foreground">vehicle profiles</div></div>
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.pendingReviews}</div><div className="text-xs text-muted-foreground">vehicle matches to review</div></div>
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.pendingPlateAssociations}</div><div className="text-xs text-muted-foreground">plate associations to review</div></div>
            <div className="rounded-md border bg-background p-3"><div className="text-2xl font-semibold">{data.stats.pendingDirectionReviews}</div><div className="text-xs text-muted-foreground">direction candidates</div></div>
          </div>
          {data.canAnalyze && (
            <Button onClick={analyze} disabled={Boolean(busy)}>
              {busy === "analyze" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Analyze next 100 unassigned captures
            </Button>
          )}
          {message && <p role="status" className="rounded-md border bg-background p-3 text-sm">{message}</p>}
        </CardContent>
      </Card>}

      {view === "review" && <section className="space-y-4">
        <div><h2 className="text-2xl font-semibold">Needs Review</h2><p className="text-sm text-muted-foreground">Choose one queue. Counts cover the full database and each queue keeps its own page.</p></div>
        <div className="flex flex-wrap gap-2 rounded-lg border bg-card p-3">
          <Button asChild variant={activeQueue === "vehicle" ? "default" : "outline"}>
            <Link href="/visual_search/vehicles/review?queue=vehicle">Vehicle Matches <Badge variant="secondary" className="ml-2">{data.stats.pendingReviews}</Badge></Link>
          </Button>
          <Button asChild variant={activeQueue === "plates" ? "default" : "outline"}>
            <Link href="/visual_search/vehicles/review?queue=plates">Plate Associations <Badge variant="secondary" className="ml-2">{data.stats.pendingPlateAssociations}</Badge></Link>
          </Button>
          <Button asChild variant={activeQueue === "direction" ? "default" : "outline"}>
            <Link href="/visual_search/vehicles/review?queue=direction">Directions <Badge variant="secondary" className="ml-2">{data.stats.pendingDirectionReviews}</Badge></Link>
          </Button>
          {data.canManageSettings && <Button asChild variant={activeQueue === "setup" ? "default" : "outline"}>
            <Link href="/visual_search/vehicles/review?queue=setup">Setup Attention</Link>
          </Button>}
        </div>

        {activeQueue === "vehicle" && <Card>
          <CardHeader><CardTitle className="text-lg">Vehicle matches</CardTitle><CardDescription>Confirm a suggested grouping or separate the capture into its own vehicle profile.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {data.suggestions.length === 0 ? <EmptyReview>No vehicle matches are waiting for review.</EmptyReview> : (
              <div className="grid gap-4 xl:grid-cols-2">
                {data.suggestions.map((suggestion) => (
                  <Card key={suggestion.readId}>
                    <CardHeader className="pb-3"><div className="flex items-center justify-between gap-3"><CardTitle className="text-base">Suggested Vehicle #{suggestion.clusterId}</CardTitle><Badge variant="outline">{percent(suggestion.similarity)} ReID</Badge></div></CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <div><div className="relative aspect-video overflow-hidden rounded-md bg-muted"><NextImage src={suggestion.candidateImageUrl} alt="Candidate vehicle" fill sizes="40vw" className="object-cover" unoptimized /></div><div className="mt-2 text-sm font-mono">{suggestion.candidatePlate}</div><div className="text-xs text-muted-foreground">New capture · {suggestion.candidateCamera}</div></div>
                        <div><div className="relative aspect-video overflow-hidden rounded-md bg-muted"><NextImage src={suggestion.representativeImageUrl} alt="Cluster representative vehicle" fill sizes="40vw" className="object-cover" unoptimized /></div><div className="mt-2 text-sm font-mono">{suggestion.representativePlate}</div><div className="text-xs text-muted-foreground">Current representative · {suggestion.representativeCamera}</div></div>
                      </div>
                      {data.canReview && <div className="grid grid-cols-2 gap-2">
                        <Button disabled={Boolean(busy)} onClick={() => reviewCluster(suggestion.readId, "confirm")}>
                          {busy === `cluster:${suggestion.readId}:confirm` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />} Confirm vehicle
                        </Button>
                        <Button variant="outline" disabled={Boolean(busy)} onClick={() => reviewCluster(suggestion.readId, "separate")}>
                          {busy === `cluster:${suggestion.readId}:separate` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Split className="mr-2 h-4 w-4" />} Different vehicle
                        </Button>
                      </div>}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
            <PaginationControls pagination={data.pagination.vehicleReviews} onPageChange={(value) => page("vehicleReviewPage", value)} />
          </CardContent>
        </Card>}

        {activeQueue === "plates" && <Card>
          <CardHeader><CardTitle className="text-lg">Plate associations</CardTitle><CardDescription>Review every proposed effective-plate link without searching through vehicle profiles.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {data.plateAssociationReviews.length === 0 ? <EmptyReview>No plate associations are waiting for review.</EmptyReview> : (
              <div className="grid gap-4 xl:grid-cols-2">
                {data.plateAssociationReviews.map((association) => (
                  <Card key={association.id}>
                    <CardHeader className="pb-3"><div className="flex items-start justify-between gap-3"><div><CardTitle className="text-base">Vehicle #{association.clusterId} · <span className="font-mono">{association.plateNumber}</span></CardTitle><CardDescription>{association.evidenceCount} confirmed capture{association.evidenceCount === 1 ? "" : "s"} · {percent(association.confidence)} mean ReID</CardDescription></div><Badge variant="outline">Suggested</Badge></div></CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <div><div className="relative aspect-video overflow-hidden rounded-md bg-muted"><NextImage src={association.representativeImageUrl} alt={`Vehicle ${association.clusterId} representative`} fill sizes="40vw" className="object-cover" unoptimized /></div><div className="mt-2 text-xs text-muted-foreground">Profile representative · {association.representativeCamera}</div></div>
                        <div><div className="relative aspect-video overflow-hidden rounded-md bg-muted"><NextImage src={association.evidenceImageUrl} alt={`Confirmed evidence for ${association.plateNumber}`} fill sizes="40vw" className="object-cover" unoptimized /></div><div className="mt-2 text-xs text-muted-foreground">Confirmed evidence · {association.evidenceCamera} · {when(association.evidenceTimestamp)}</div></div>
                      </div>
                      <div className="flex flex-wrap gap-2">{association.knownName && <Badge>{association.knownName}</Badge>}{association.tags.map((tag) => <Badge key={tag.name} variant="secondary">{tag.name}</Badge>)}</div>
                      {data.canReview && <AssociationDecision association={association} busy={busy} onReview={(plateNumber, decision) => reviewAssociation(association.clusterId, plateNumber, decision)} />}
                      <Button asChild variant="ghost" size="sm"><Link href={`/visual_search/vehicles/${association.clusterId}`}>Open full profile <ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
            <PaginationControls pagination={data.pagination.plateReviews} onPageChange={(value) => page("plateReviewPage", value)} />
          </CardContent>
        </Card>}

        {activeQueue === "direction" && <Card>
          <CardHeader><CardTitle className="text-lg">Direction reviews</CardTitle><CardDescription>Unlabeled, unknown direction captures are balanced across configured cameras. A review immediately becomes authoritative calibration evidence.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {data.directionReviews.length === 0 ? <EmptyReview>No unknown direction captures currently need review.</EmptyReview> : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {data.directionReviews.map((capture) => (
                  <Card key={capture.readId} className="overflow-hidden">
                    <div className="relative aspect-video bg-muted"><NextImage src={capture.imageUrl} alt={`Direction review ${capture.plateNumber}`} fill sizes="(min-width:1280px) 30vw, 50vw" className="object-cover" unoptimized /></div>
                    <CardContent className="space-y-3 p-4">
                      <div className="flex items-start justify-between gap-2"><div><div className="font-mono font-semibold">{capture.plateNumber}</div><div className="text-xs text-muted-foreground">{capture.cameraName} · {when(capture.timestamp)}</div></div><Badge variant="outline">Unknown</Badge></div>
                      {data.canReview && <div className="grid grid-cols-2 gap-2">
                        <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => reviewDirection(capture.readId, "front")}>
                          {busy === `direction:${capture.readId}:front` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Front view
                        </Button>
                        <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => reviewDirection(capture.readId, "rear")}>
                          {busy === `direction:${capture.readId}:rear` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Rear view
                        </Button>
                      </div>}
                      <p className="text-xs text-muted-foreground">Front → {capture.frontDirectionLabel} · Rear → {capture.rearDirectionLabel}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
            <PaginationControls pagination={data.pagination.directionReviews} onPageChange={(value) => page("directionReviewPage", value)} />
          </CardContent>
        </Card>}

        {activeQueue === "setup" && data.canManageSettings && <div className="space-y-4">
          <AttentionSummary data={data} />
          {data.calibration && !data.calibration.recommendation && <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-lg"><Gauge className="h-5 w-5" />Optional ReID calibration</CardTitle><CardDescription>Same/different labels improve local threshold analysis but are not a pending identity decision.</CardDescription></CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">Still useful: {data.calibration.neededSameVehicle} same-vehicle and {data.calibration.neededDifferentVehicle} different-vehicle labels.</p>
              <Button asChild variant="outline"><Link href="/visual_search">Open Visual Search</Link></Button>
            </CardContent>
          </Card>}
        </div>}
      </section>}

      {view === "profiles" && <section className="space-y-4">
        <div><h2 className="text-xl font-semibold">Vehicle profiles</h2><p className="text-sm text-muted-foreground">Profiles are paginated independently from all review queues.</p></div>
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_220px_240px_auto]">
              <div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input value={profileSearch} onChange={(event) => setProfileSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyFilters(); }} placeholder="Search profile plates" className="pl-9" /></div>
              <Select value={data.filters.profileStatus || "all"} onValueChange={(value) => setFilter("profileStatus", value)}><SelectTrigger><SelectValue placeholder="All statuses" /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem><SelectItem value="shadow">Shadow</SelectItem><SelectItem value="confirmed">Confirmed</SelectItem></SelectContent></Select>
              <Select value={data.filters.profileCamera || "all"} onValueChange={(value) => setFilter("profileCamera", value)}><SelectTrigger><SelectValue placeholder="All cameras" /></SelectTrigger><SelectContent><SelectItem value="all">All cameras</SelectItem>{data.cameras.map((camera) => <SelectItem key={camera} value={camera}>{camera}</SelectItem>)}</SelectContent></Select>
              <Button onClick={applyFilters}>Apply</Button>
            </div>
            <PaginationControls pagination={data.pagination.profiles} onPageChange={(value) => page("profilesPage", value)} />
          </CardContent>
        </Card>
        {data.clusters.length === 0 ? <EmptyReview>No vehicle profiles match these filters.</EmptyReview> : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.clusters.map((cluster) => (
              <Card key={cluster.id} className="overflow-hidden">
                <div className="relative aspect-video bg-muted"><NextImage src={cluster.representativeImageUrl} alt={`Representative for Vehicle ${cluster.id}`} fill sizes="(min-width:1280px) 30vw, 50vw" className="object-cover" unoptimized /></div>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-center justify-between"><div className="font-semibold">Vehicle #{cluster.id}</div><Badge variant="secondary">{cluster.status}</Badge></div>
                  <div className="text-sm">{cluster.captureCount} captures · {cluster.confirmedCount} confirmed</div>
                  {cluster.representativeColor && <div className="text-sm capitalize">{cluster.representativeColor} · {percent(cluster.representativeColorConfidence)} color</div>}
                  <div className="text-xs text-muted-foreground">Last seen {when(cluster.lastSeen)}</div>
                  {cluster.confirmedPlateAssociations.length > 0 && <div className="space-y-1"><div className="text-xs font-medium text-muted-foreground">Confirmed plates</div><div className="flex flex-wrap gap-1">{cluster.confirmedPlateAssociations.map((association) => <Badge key={association.plateNumber} className="font-mono">{association.plateNumber}</Badge>)}</div></div>}
                  {cluster.suggestedPlateAssociations.length > 0 && <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"><AlertTriangle className="h-3.5 w-3.5" />Review in Needs Review &gt; Plate Associations</div>}
                  <div className="flex flex-wrap gap-1">{cluster.observedPlates.slice(0, 5).map((plate) => <Badge key={plate} variant="outline" className="font-mono">{plate}</Badge>)}</div>
                  <Button asChild variant="outline" className="w-full"><Link href={`/visual_search/vehicles/${cluster.id}`}>Open vehicle profile <ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        <PaginationControls pagination={data.pagination.profiles} onPageChange={(value) => page("profilesPage", value)} />
      </section>}
    </div>
  );
}
