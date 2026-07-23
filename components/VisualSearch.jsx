"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import NextImage from "next/image";
import { Camera, Images, Loader2, Play, Save, Search, SlidersHorizontal, UploadCloud, X } from "lucide-react";

import {
  findSimilarCaptures,
  findSimilarUploadedCaptures,
  getVisualSearchBootstrap,
  indexCameraCaptureAssetsBatch,
  indexCaptureAssetsBatch,
  saveCameraVisualProfile,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { calculateVehicleCrop } from "@/lib/image-similarity.mjs";

const UPLOAD_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

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
          className={capture.uploaded ? "object-contain" : "object-cover"}
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
              : `OpenVINO Vehicle ReID cosine similarity: ${capture.score}%. Plate text is displayed for review but is not used in this score or ranking.`}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {onSearch && capture.readId && (
            <Button size="sm" onClick={() => onSearch(capture.readId)}>
              <Search className="mr-2 h-4 w-4" /> Find matches
            </Button>
          )}
          {capture.readId && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/live_feed?search=${encodeURIComponent(capture.plateNumber)}&matchMode=off`}>
                Plate details
              </Link>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function percentBox(box, width, height) {
  return {
    left: `${box.left / width * 100}%`,
    top: `${box.top / height * 100}%`,
    width: `${box.width / width * 100}%`,
    height: `${box.height / height * 100}%`,
  };
}

function CameraCropSetup({ profiles, onSaved }) {
  const [selectedCamera, setSelectedCamera] = useState(profiles[0]?.cameraName || "");
  const selected = profiles.find((profile) => profile.cameraName === selectedCamera) || profiles[0];
  const [draft, setDraft] = useState(selected || null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!selected) return;
    setDraft(selected);
    setMessage("");
  }, [selected]);

  if (!selected || !draft) return null;
  const preview = selected.preview;
  const crop = preview ? calculateVehicleCrop({
    width: preview.width,
    height: preview.height,
    cropCoordinates: preview.cropCoordinates,
    profile: draft,
  }) : null;
  const plate = preview && Array.isArray(preview.cropCoordinates) && preview.cropCoordinates.length === 4
    ? {
        left: Math.min(preview.cropCoordinates[0], preview.cropCoordinates[2]),
        top: Math.min(preview.cropCoordinates[1], preview.cropCoordinates[3]),
        width: Math.abs(preview.cropCoordinates[2] - preview.cropCoordinates[0]),
        height: Math.abs(preview.cropCoordinates[3] - preview.cropCoordinates[1]),
      }
    : null;

  const saveAndReindex = async () => {
    setSaving(true);
    setMessage("");
    try {
      const saved = await saveCameraVisualProfile({
        cameraName: selected.cameraName,
        cropMode: draft.cropMode,
        contextPercent: draft.contextPercent,
        verticalOffsetPercent: draft.verticalOffsetPercent,
      });
      if (!saved.success) {
        setMessage(saved.error);
        return;
      }
      const indexed = await indexCameraCaptureAssetsBatch(selected.cameraName, 20);
      if (!indexed.success) {
        setMessage(`Profile saved. ${indexed.error}`);
        return;
      }
      setMessage(`Profile saved as revision ${saved.data.profileVersion}. Reindexed ${indexed.data.succeeded} of ${indexed.data.processed} captures.`);
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Camera className="h-5 w-5" /> Camera crop setup
        </CardTitle>
        <CardDescription>
          Tune the derived vehicle-search region per camera. Original capture images are never changed.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)]">
        <div className="space-y-3">
          {preview ? (
            <>
              <div
                className="relative mx-auto w-full max-w-4xl overflow-hidden rounded-lg border bg-muted"
                style={{ aspectRatio: `${preview.width} / ${preview.height}` }}
              >
                <NextImage src={preview.imageUrl} alt={`Crop preview for ${selected.cameraName}`} fill className="object-contain" unoptimized />
                {crop && <div className="absolute border-2 border-emerald-400 bg-emerald-400/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]" style={percentBox(crop, preview.width, preview.height)} />}
                {plate && <div className="absolute border-2 border-amber-400" style={percentBox(plate, preview.width, preview.height)} />}
              </div>
              <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>Latest: {preview.plateNumber} · {formatTimestamp(preview.timestamp)}</span>
                <span><span className="text-amber-500">Amber</span> plate · <span className="text-emerald-500">Green</span> derived crop</span>
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">No source image is available for this camera.</div>
          )}
        </div>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label>Camera</Label>
            <Select value={selected.cameraName} onValueChange={setSelectedCamera}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{profiles.map((profile) => <SelectItem key={profile.cameraName} value={profile.cameraName}>{profile.cameraName}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Crop mode</Label>
            <Select value={draft.cropMode} onValueChange={(cropMode) => setDraft((current) => ({ ...current, cropMode }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (recommended)</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
                <SelectItem value="full_frame">Full frame</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Auto adapts to plate size. Use Full frame for a future overview camera.</p>
          </div>
          <div className="space-y-3">
            <div className="flex justify-between"><Label>Vehicle context</Label><span className="text-sm tabular-nums">{draft.cropMode === "full_frame" ? 100 : draft.contextPercent}%</span></div>
            <Slider min={40} max={100} step={5} value={[draft.contextPercent]} disabled={draft.cropMode !== "custom"} onValueChange={([contextPercent]) => setDraft((current) => ({ ...current, contextPercent }))} />
            <p className="text-xs text-muted-foreground">Lower is tighter; higher includes more of the vehicle and surroundings. Custom 100% uses the full source width and height.</p>
          </div>
          <div className="space-y-3">
            <div className="flex justify-between"><Label>Vertical position</Label><span className="text-sm tabular-nums">{draft.verticalOffsetPercent > 0 ? "+" : ""}{draft.verticalOffsetPercent}%</span></div>
            <Slider min={-25} max={25} step={1} value={[draft.verticalOffsetPercent]} disabled={draft.cropMode === "full_frame"} onValueChange={([verticalOffsetPercent]) => setDraft((current) => ({ ...current, verticalOffsetPercent }))} />
            <p className="text-xs text-muted-foreground">Move the crop upward or downward when the plate is not centered on the vehicle.</p>
          </div>
          <Button className="w-full" onClick={saveAndReindex} disabled={saving || !preview}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save & reindex next 20
          </Button>
          <p className="text-xs text-muted-foreground">Current saved revision: {selected.profileVersion}</p>
          {message && <div role="status" className="rounded-md border p-3 text-sm">{message}</div>}
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
  const [uploadedQuery, setUploadedQuery] = useState(null);
  const [draggingUpload, setDraggingUpload] = useState(false);
  const initialSearchStarted = useRef(false);
  const uploadInputRef = useRef(null);

  const refreshBootstrap = async () => {
    const result = await getVisualSearchBootstrap();
    if (result.success) setBootstrap(result.data);
    else setError(result.error);
  };

  const runSearch = async (readId) => {
    setSearching(true);
    setError("");
    try {
      setUploadedQuery(null);
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

  const runUploadedSearch = async (query = uploadedQuery) => {
    if (!query) return;
    setSearching(true);
    setError("");
    try {
      const result = await findSimilarUploadedCaptures({
        dataUrl: query.dataUrl,
        fileName: query.fileName,
        cameraNames: selectedCameras,
        startDate: startDate || null,
        endDate: endDate ? new Date(`${endDate}T23:59:59.999`).toISOString() : null,
        limit: 24,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      setSearchResult({
        ...result.data,
        source: { ...result.data.source, imageUrl: query.dataUrl },
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSearching(false);
    }
  };

  const selectUpload = (file) => {
    setError("");
    if (!file || !UPLOAD_TYPES.has(file.type)) {
      setError("Choose a JPEG, PNG, or WebP image.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("Choose an image no larger than 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("The selected image could not be read.");
    reader.onload = () => {
      const query = { dataUrl: String(reader.result), fileName: file.name };
      setUploadedQuery(query);
      setSearchResult(null);
    };
    reader.readAsDataURL(file);
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
            <input
              ref={uploadInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              onChange={(event) => selectUpload(event.target.files?.[0])}
            />
            <div
              role="button"
              tabIndex={0}
              onClick={() => uploadInputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") uploadInputRef.current?.click();
              }}
              onDragEnter={(event) => { event.preventDefault(); setDraggingUpload(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { event.preventDefault(); setDraggingUpload(false); }}
              onDrop={(event) => {
                event.preventDefault();
                setDraggingUpload(false);
                selectUpload(event.dataTransfer.files?.[0]);
              }}
              className={`rounded-lg border border-dashed p-5 text-center transition-colors ${draggingUpload ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
            >
              <UploadCloud className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
              <div className="text-sm font-medium">Drop a vehicle image here, or choose a file</div>
              <div className="mt-1 text-xs text-muted-foreground">JPEG, PNG, or WebP · maximum 5 MB · processed transiently</div>
              <div className="mt-1 text-xs text-muted-foreground">Best results when the vehicle fills most of the image.</div>
            </div>
            {uploadedQuery && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{uploadedQuery.fileName}</div>
                  <div className="text-xs text-muted-foreground">Ready to compare with the current filters</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => runUploadedSearch()} disabled={searching}>
                    {searching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
                    Search upload
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Clear uploaded image"
                    onClick={() => { setUploadedQuery(null); setSearchResult(null); if (uploadInputRef.current) uploadInputRef.current.value = ""; }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
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
                <Button variant="outline" className="w-full" onClick={() => searchResult.source.uploaded ? runUploadedSearch() : runSearch(searchResult.source.readId)} disabled={searching}>
                  {searching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Apply filters
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {bootstrap?.canManageIndex && bootstrap.cameraProfiles?.length > 0 && (
        <CameraCropSetup profiles={bootstrap.cameraProfiles} onSaved={refreshBootstrap} />
      )}

      {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>}
      {searching && <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Comparing indexed vehicle crops…</div>}

      {!searching && searchResult && (
        <section className="space-y-3">
          <div>
            <h2 className="text-xl font-semibold">Results</h2>
            <p className="text-sm text-muted-foreground">
              {searchResult.matches.length} candidates from {searchResult.searchedCandidates.toLocaleString()} filtered indexed captures.
              Results are ranked only by learned Vehicle ReID image embeddings. Plate text never affects inclusion, score, or order; candidates still require human review.
            </p>
          </div>
          {searchResult.matches.length ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {searchResult.matches.map((capture) => <CaptureCard key={capture.readId} capture={capture} onSearch={runSearch} />)}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No captures with current Vehicle ReID embeddings matched these filters. Index more captures and try again.
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
