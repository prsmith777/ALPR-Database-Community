"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import NextImage from "next/image";
import { Images, Loader2, Play, Search, SlidersHorizontal } from "lucide-react";

import {
  findSimilarCaptures,
  getVisualSearchBootstrap,
  indexCaptureAssetsBatch,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";

function formatTimestamp(value) {
  if (!value) return "Unknown time";
  return new Date(value).toLocaleString();
}

function CaptureCard({ capture, source = false, onSearch }) {
  return (
    <Card className={source ? "border-blue-500/50" : "overflow-hidden"}>
      <div className="relative aspect-video overflow-hidden bg-muted">
        <NextImage
          src={capture.imageUrl}
          alt={`Vehicle region for ${capture.plateNumber}`}
          fill
          sizes="(min-width: 1280px) 30vw, (min-width: 640px) 50vw, 100vw"
          className="object-cover"
          unoptimized
        />
        {source && <Badge className="absolute left-2 top-2">Search source</Badge>}
        {capture.label && (
          <Badge variant="secondary" className="absolute right-2 top-2">
            {capture.score}%
          </Badge>
        )}
      </div>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-lg font-semibold">{capture.plateNumber}</div>
            <div className="text-xs text-muted-foreground">{capture.cameraName}</div>
          </div>
          {capture.label && <Badge variant="outline">{capture.label}</Badge>}
        </div>
        <div className="text-xs text-muted-foreground">{formatTimestamp(capture.timestamp)}</div>
        {capture.label && (
          <p className="text-xs text-muted-foreground">
            {capture.exact
              ? "The complete stored source image has the same SHA-256 hash."
              : `${capture.distance} of 64 perceptual bits differ in the derived vehicle crop.`}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {onSearch && (
            <Button size="sm" onClick={() => onSearch(capture.readId)}>
              <Search className="mr-2 h-4 w-4" /> Find matches
            </Button>
          )}
          <Button asChild size="sm" variant="outline">
            <Link href={`/live_feed?search=${encodeURIComponent(capture.plateNumber)}&matchMode=off`}>
              Plate details
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function VisualSearch({ initialResult, initialReadId }) {
  const initialData = initialResult?.success ? initialResult.data : null;
  const [bootstrap, setBootstrap] = useState(initialData);
  const [error, setError] = useState(initialResult?.success ? "" : initialResult?.error || "Unable to load visual search.");
  const [indexing, setIndexing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState(null);
  const [selectedCameras, setSelectedCameras] = useState([]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const initialSearchStarted = useRef(false);

  const refreshBootstrap = async () => {
    const result = await getVisualSearchBootstrap();
    if (result.success) setBootstrap(result.data);
    else setError(result.error);
  };

  const runSearch = async (readId) => {
    setSearching(true);
    setError("");
    try {
      const result = await findSimilarCaptures({
        readId,
        cameraNames: selectedCameras,
        startDate: startDate || null,
        endDate: endDate ? new Date(`${endDate}T23:59:59.999`).toISOString() : null,
        limit: 24,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      setSearchResult(result.data);
      await refreshBootstrap();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    if (!initialReadId || initialSearchStarted.current) return;
    initialSearchStarted.current = true;
    runSearch(initialReadId);
    // Filters intentionally use their initial values for a linked capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialReadId]);

  const runIndexBatch = async () => {
    setIndexing(true);
    setError("");
    try {
      const result = await indexCaptureAssetsBatch(20);
      if (!result.success) {
        setError(result.error);
        return;
      }
      await refreshBootstrap();
    } finally {
      setIndexing(false);
    }
  };

  const toggleCamera = (camera, checked) => {
    setSelectedCameras((current) =>
      checked ? [...new Set([...current, camera])] : current.filter((item) => item !== camera)
    );
  };

  const status = bootstrap?.status || { total: 0, ready: 0, failed: 0, retryable: 0, pending: 0 };
  const completion = status.total ? Math.round((status.ready / status.total) * 100) : 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Images className="h-5 w-5" /> Find visually similar vehicles
            </CardTitle>
            <CardDescription>
              Choose an indexed capture below, or open any plate image and select Find similar vehicle.
              Search uses local derived crops and never changes the original image.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {searchResult ? (
              <CaptureCard capture={searchResult.source} source onSearch={runSearch} />
            ) : (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                Select a recent indexed capture to begin.
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Local index</CardTitle>
              <CardDescription>Newest unindexed captures are processed first in resumable batches.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between text-sm">
                <span>{status.ready.toLocaleString()} ready</span>
                <span>{status.pending.toLocaleString()} pending</span>
              </div>
              <Progress value={completion} aria-label={`${completion}% indexed`} />
              <div className="text-xs text-muted-foreground">
                {completion}% of {status.total.toLocaleString()} image captures
                {status.failed ? ` · ${status.failed} need attention` : ""}
              </div>
              {bootstrap?.canManageIndex && (
                <Button className="w-full" onClick={runIndexBatch} disabled={indexing || (status.pending === 0 && status.retryable === 0)}>
                  {indexing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                  Index next 20
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <SlidersHorizontal className="h-4 w-4" /> Result filters
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="visual-start">From</Label>
                  <Input id="visual-start" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="visual-end">Through</Label>
                  <Input id="visual-end" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Cameras</Label>
                <div className="max-h-36 space-y-2 overflow-y-auto rounded-md border p-3">
                  {(bootstrap?.cameras || []).length ? bootstrap.cameras.map((camera) => (
                    <label key={camera} className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={selectedCameras.includes(camera)}
                        onCheckedChange={(checked) => toggleCamera(camera, checked === true)}
                      />
                      {camera}
                    </label>
                  )) : <span className="text-xs text-muted-foreground">Cameras appear after captures are indexed.</span>}
                </div>
              </div>
              {searchResult && (
                <Button variant="outline" className="w-full" onClick={() => runSearch(searchResult.source.readId)} disabled={searching}>
                  {searching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Apply filters
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>}
      {searching && <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Comparing indexed vehicle crops…</div>}

      {!searching && searchResult && (
        <section className="space-y-3">
          <div>
            <h2 className="text-xl font-semibold">Matches</h2>
            <p className="text-sm text-muted-foreground">
              {searchResult.matches.length} matches from {searchResult.searchedCandidates.toLocaleString()} filtered indexed captures.
              Lower bit distance means a closer perceptual match.
            </p>
          </div>
          {searchResult.matches.length ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {searchResult.matches.map((capture) => <CaptureCard key={capture.readId} capture={capture} onSearch={runSearch} />)}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No indexed crops met the current similarity threshold and filters.
            </div>
          )}
        </section>
      )}

      {!searchResult && bootstrap?.recent?.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Recent indexed captures</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {bootstrap.recent.map((capture) => <CaptureCard key={capture.readId} capture={capture} onSearch={runSearch} />)}
          </div>
        </section>
      )}
    </div>
  );
}
