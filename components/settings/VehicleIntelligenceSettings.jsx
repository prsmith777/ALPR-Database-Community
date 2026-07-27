"use client";

import NextImage from "next/image";
import { useEffect, useMemo, useState } from "react";
import { BrainCircuit, Check, Loader2, Play, RotateCcw, Save } from "lucide-react";

import {
  getVehicleDirectionSetup,
  labelVehicleOrientation,
  previewVehicleDirectionReevaluation,
  queueVehicleDirectionReevaluation,
  runVehicleDirectionBackfillBatch,
  saveVehicleDirectionProfile,
} from "@/app/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

function statusText(profile, minimum) {
  if (!profile.configured) return "Needs direction meanings";
  if (profile.frontCount < minimum || profile.rearCount < minimum) return "Collecting examples";
  return profile.enabled ? "Ready to classify" : "Paused";
}

export default function VehicleIntelligenceSettings({ initialData }) {
  const [data, setData] = useState(initialData);
  const [cameraName, setCameraName] = useState(initialData.selectedCamera || "");
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [reevaluationPreview, setReevaluationPreview] = useState(null);
  const profile = useMemo(
    () => data.profiles.find((item) => item.cameraName === cameraName) || data.profiles[0] || null,
    [cameraName, data.profiles]
  );

  useEffect(() => {
    if (!profile) return;
    setDraft({ ...profile });
  }, [profile]);

  useEffect(() => {
    const pending = Number(data.backfill?.pending || 0)
      + Number(data.backfill?.imagesAwaitingIndex || 0);
    if (!pending) return undefined;
    const timer = window.setInterval(async () => {
      const result = await getVehicleDirectionSetup(cameraName);
      if (result.success) setData(result.data);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [cameraName, data.backfill?.imagesAwaitingIndex, data.backfill?.pending]);

  const reload = async (selected = cameraName) => {
    const result = await getVehicleDirectionSetup(selected);
    if (!result.success) throw new Error(result.error);
    setData(result.data);
    setCameraName(result.data.selectedCamera || selected);
  };

  const selectCamera = async (value) => {
    setCameraName(value);
    setBusy("loading");
    setMessage("");
    try { await reload(value); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const saveProfile = async () => {
    setBusy("profile");
    setMessage("");
    try {
      const result = await saveVehicleDirectionProfile(draft);
      if (!result.success) throw new Error(result.error);
      await reload(cameraName);
      setMessage("Camera direction setup saved. Recent captures were updated and the remaining historical reads were queued.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const saveLabel = async (readId, orientation) => {
    setBusy(`${readId}:${orientation}`);
    setMessage("");
    try {
      const result = await labelVehicleOrientation({ readId, orientation });
      if (!result.success) throw new Error(result.error);
      await reload(cameraName);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const runDirectionBackfill = async () => {
    setBusy("backfill");
    setMessage("");
    try {
      const result = await runVehicleDirectionBackfillBatch(20);
      if (!result.success) throw new Error(result.error);
      await reload(cameraName);
      setMessage(
        result.data.processed
          ? `Processed ${result.data.processed} historical captures: ${result.data.succeeded} completed, ${result.data.failed} failed.`
          : "No indexed historical captures are waiting for direction analysis."
      );
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const openReevaluation = async (selectedCameraName = null) => {
    const pendingState = selectedCameraName ? "preview-camera" : "preview-all";
    setBusy(pendingState);
    setMessage("");
    try {
      const result = await previewVehicleDirectionReevaluation({ cameraName: selectedCameraName });
      if (!result.success) throw new Error(result.error);
      setReevaluationPreview(result.data);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const confirmReevaluation = async () => {
    if (!reevaluationPreview) return;
    setBusy("reevaluate");
    setMessage("");
    try {
      const result = await queueVehicleDirectionReevaluation({
        cameraName: reevaluationPreview.cameraName,
      });
      if (!result.success) throw new Error(result.error);
      setReevaluationPreview(null);
      await reload(cameraName);
      setMessage(
        `Queued ${result.data.queued.toLocaleString()} historical captures across ${result.data.cameraCount.toLocaleString()} camera${result.data.cameraCount === 1 ? "" : "s"}. `
        + `${result.data.manualPreserved.toLocaleString()} human-reviewed capture${result.data.manualPreserved === 1 ? " was" : "s were"} preserved. Background processing will continue automatically.`
      );
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const backfill = data.backfill || {
    eligible: 0,
    populated: 0,
    completed: 0,
    pending: 0,
    ready: 0,
    unknown: 0,
    failed: 0,
    imagesAwaitingIndex: 0,
    imageFailures: 0,
  };
  const backfillCompletion = backfill.eligible
    ? Math.round(backfill.completed / backfill.eligible * 100)
    : 100;

  return (
    <SettingsShell
      activeId="vehicleIntelligence"
      title="Vehicle Intelligence"
      description="Teach each camera what front and rear vehicle views mean. Camera names and directions are never hard-coded."
    >
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><BrainCircuit className="h-5 w-5" /> Camera direction setup</CardTitle>
            <CardDescription>
              This first phase uses existing single-frame Vehicle ReID descriptors. It stores labels and results only—no video clips.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {!profile ? (
              <p className="text-sm text-muted-foreground">No cameras with plate reads are available yet.</p>
            ) : (
              <>
                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                  <div className="space-y-2">
                    <Label>Camera</Label>
                    <Select value={cameraName} onValueChange={selectCamera}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {data.profiles.map((item) => <SelectItem key={item.cameraName} value={item.cameraName}>{item.cameraName}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <Badge variant="outline" className="h-9 justify-center px-3">{statusText(profile, data.minimumSamplesPerView)}</Badge>
                </div>

                {draft && (
                  <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="front-direction">When the front of the vehicle is visible</Label>
                      <Input id="front-direction" value={draft.frontDirectionLabel} onChange={(event) => setDraft({ ...draft, frontDirectionLabel: event.target.value })} placeholder="Example: Eastbound or Exiting driveway" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="rear-direction">When the rear of the vehicle is visible</Label>
                      <Input id="rear-direction" value={draft.rearDirectionLabel} onChange={(event) => setDraft({ ...draft, rearDirectionLabel: event.target.value })} placeholder="Example: Westbound or Entering driveway" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="direction-confidence">Minimum confidence ({Math.round(draft.minimumConfidence * 100)}%)</Label>
                      <input id="direction-confidence" type="range" min="50" max="95" step="1" value={Math.round(draft.minimumConfidence * 100)} onChange={(event) => setDraft({ ...draft, minimumConfidence: Number(event.target.value) / 100 })} className="w-full accent-primary" />
                      <p className="text-xs text-muted-foreground">Anything below this level stays Unknown.</p>
                    </div>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2">
                      <div><div className="text-sm font-medium">Direction classification</div><div className="text-xs text-muted-foreground">Pause without deleting calibration.</div></div>
                      <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
                    </div>
                    <div className="md:col-span-2">
                      <Button onClick={saveProfile} disabled={Boolean(busy)}>
                        {busy === "profile" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                        Save camera setup
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
            {message && <p className="rounded-md border p-3 text-sm">{message}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Historical direction backfill</CardTitle>
            <CardDescription>
              Existing image-backed reads are indexed and evaluated in safe, resumable batches. Human front/rear reviews remain authoritative, and this process does not send historical notifications.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span>{backfill.completed.toLocaleString()} of {backfill.eligible.toLocaleString()} indexed captures completed</span>
              <Badge variant={backfill.pending ? "outline" : "secondary"}>
                {backfill.pending ? `${backfill.pending.toLocaleString()} pending` : "Up to date"}
              </Badge>
            </div>
            <Progress value={backfillCompletion} aria-label={`${backfillCompletion}% of historical directions evaluated`} />
            <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-5">
              <div className="rounded-md border p-3"><div className="text-xl font-semibold">{backfill.ready.toLocaleString()}</div><div className="text-xs text-muted-foreground">directions assigned</div></div>
              <div className="rounded-md border p-3"><div className="text-xl font-semibold">{backfill.unknown.toLocaleString()}</div><div className="text-xs text-muted-foreground">remain unknown</div></div>
              <div className="rounded-md border p-3"><div className="text-xl font-semibold">{backfill.imagesAwaitingIndex.toLocaleString()}</div><div className="text-xs text-muted-foreground">awaiting ReID</div></div>
              <div className="rounded-md border p-3"><div className="text-xl font-semibold">{backfill.imageFailures.toLocaleString()}</div><div className="text-xs text-muted-foreground">image failures</div></div>
              <div className="rounded-md border p-3"><div className="text-xl font-semibold">{backfill.failed.toLocaleString()}</div><div className="text-xs text-muted-foreground">direction failures</div></div>
            </div>
            <p className="text-xs text-muted-foreground">
              The background visual-intelligence worker continues automatically using the configured indexing pace and safety limits. Captures below the confidence threshold correctly remain Unknown.
            </p>
            <Button
              variant="secondary"
              onClick={runDirectionBackfill}
              disabled={Boolean(busy) || backfill.pending === 0}
            >
              {busy === "backfill" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Run one direction batch now
            </Button>
            <div className="rounded-lg border p-4">
              <div className="space-y-1">
                <div className="font-medium">Re-evaluate completed history</div>
                <p className="text-sm text-muted-foreground">
                  Apply the latest front/rear examples to earlier machine-generated results. Human-reviewed directions remain unchanged, and historical notifications are never sent.
                </p>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => openReevaluation(cameraName)}
                  disabled={Boolean(busy) || !profile}
                >
                  {busy === "preview-camera" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                  Re-evaluate selected camera...
                </Button>
                <Button
                  variant="outline"
                  onClick={() => openReevaluation(null)}
                  disabled={Boolean(busy) || data.profiles.length === 0}
                >
                  {busy === "preview-all" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                  Re-evaluate all cameras...
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {profile && (
          <Card>
            <CardHeader>
              <CardTitle>Front/rear calibration</CardTitle>
              <CardDescription>
                Label at least {data.minimumSamplesPerView} clear front views and {data.minimumSamplesPerView} clear rear views for this camera. More varied examples improve reliability.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-center">
                <div className="rounded-md border p-3"><div className="text-2xl font-semibold">{profile.frontCount}</div><div className="text-xs text-muted-foreground">front examples</div></div>
                <div className="rounded-md border p-3"><div className="text-2xl font-semibold">{profile.rearCount}</div><div className="text-xs text-muted-foreground">rear examples</div></div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {data.captures.map((capture) => (
                  <div key={capture.readId} className="overflow-hidden rounded-lg border">
                    <div className="relative aspect-video bg-muted">
                      <NextImage src={capture.imageUrl} alt={`Vehicle capture ${capture.plateNumber}`} fill sizes="(min-width:1280px) 30vw, 50vw" className="object-cover" unoptimized />
                    </div>
                    <div className="space-y-3 p-3">
                      <div className="flex justify-between gap-2"><span className="font-mono font-semibold">{capture.plateNumber}</span>{capture.orientation && <Badge>{capture.orientation}</Badge>}</div>
                      <div className="grid grid-cols-2 gap-2">
                        {['front', 'rear'].map((orientation) => (
                          <Button key={orientation} size="sm" variant={capture.orientation === orientation ? "default" : "outline"} disabled={Boolean(busy)} onClick={() => saveLabel(capture.readId, orientation)}>
                            {busy === `${capture.readId}:${orientation}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : capture.orientation === orientation ? <Check className="mr-2 h-4 w-4" /> : null}
                            {orientation === 'front' ? 'Front view' : 'Rear view'}
                          </Button>
                        ))}
                      </div>
                      {capture.prediction?.status === "ready" && <p className="text-xs text-muted-foreground">Prediction: {capture.prediction.directionLabel} ({Math.round(capture.prediction.confidence * 100)}%)</p>}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
      <AlertDialog
        open={Boolean(reevaluationPreview)}
        onOpenChange={(open) => { if (!open && busy !== "reevaluate") setReevaluationPreview(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-evaluate historical directions?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  {reevaluationPreview?.cameraName
                    ? `The latest calibration examples will be applied to ${reevaluationPreview.cameraName}.`
                    : "The latest calibration examples will be applied to every configured camera."}
                </p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-md border p-3"><strong>{reevaluationPreview?.queued?.toLocaleString() || 0}</strong><br />captures queued</div>
                  <div className="rounded-md border p-3"><strong>{reevaluationPreview?.cameraCount?.toLocaleString() || 0}</strong><br />cameras included</div>
                  <div className="rounded-md border p-3"><strong>{reevaluationPreview?.previousReady?.toLocaleString() || 0}</strong><br />assigned results replaced</div>
                  <div className="rounded-md border p-3"><strong>{reevaluationPreview?.previousUnknown?.toLocaleString() || 0}</strong><br />Unknown results retried</div>
                </div>
                <p>
                  {reevaluationPreview?.manualPreserved?.toLocaleString() || 0} human-reviewed front/rear result{reevaluationPreview?.manualPreserved === 1 ? "" : "s"} will be preserved. Processing is resumable and does not send historical notifications.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "reevaluate"}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => { event.preventDefault(); confirmReevaluation(); }}
              disabled={busy === "reevaluate" || !reevaluationPreview?.queued}
            >
              {busy === "reevaluate" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
              Queue re-evaluation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsShell>
  );
}
