"use client";

import NextImage from "next/image";
import { useEffect, useMemo, useState } from "react";
import { BrainCircuit, Check, History, Images, Loader2, Pause, Play, RotateCcw, Save, ScanSearch, Settings2, Trash2, XCircle } from "lucide-react";

import {
  getVehicleDirectionSetup,
  getVehicleOverviewSetup,
  getBlueIrisVehicleFrameQueueStatus,
  labelVehicleOrientation,
  previewVehicleDirectionReevaluation,
  queueVehicleDirectionReevaluation,
  runVehicleDirectionBackfillBatch,
  saveVehicleDirectionProfile,
  saveVehicleOverviewPairProfile,
  deleteVehicleOverviewPairProfile,
  cancelBlueIrisVehicleFrameHistory,
  queueBlueIrisVehicleFrameHistory,
  runBlueIrisVehicleFrameBatch,
  setBlueIrisVehicleFrameHistoryPaused,
  setVehicleDirectionReevaluationPaused,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRouteTab } from "@/components/useRouteTab";

const VEHICLE_SETUP_ROUTES = Object.freeze({
  cameras: "/settings/vehicle-intelligence",
  views: "/settings/vehicle-intelligence/vehicle-views",
  processing: "/settings/vehicle-intelligence/processing",
  calibration: "/settings/vehicle-intelligence/calibration",
});

function statusText(profile, minimum) {
  if (!profile.configured) return "Needs direction meanings";
  if (profile.frontCount < minimum || profile.rearCount < minimum) return "Collecting examples";
  return profile.enabled ? "Ready to classify" : "Paused";
}

function compactCount(value) {
  const number = Number(value || 0);
  if (number < 1000) return number.toLocaleString();
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(number);
}

export default function VehicleIntelligenceSettings({
  initialData,
  initialFrameQueue = null,
  initialOverviewSetup = null,
}) {
  const routeTab = useRouteTab(VEHICLE_SETUP_ROUTES, "cameras");
  const [data, setData] = useState(initialData);
  const [cameraName, setCameraName] = useState(initialData.selectedCamera || "");
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [reevaluationPreview, setReevaluationPreview] = useState(null);
  const [frameQueue, setFrameQueue] = useState(initialFrameQueue);
  const [frameMessage, setFrameMessage] = useState("");
  const [frameStartDate, setFrameStartDate] = useState("");
  const [frameEndDate, setFrameEndDate] = useState("");
  const [cancelFrameHistoryOpen, setCancelFrameHistoryOpen] = useState(false);
  const [overviewSetup, setOverviewSetup] = useState(initialOverviewSetup);
  const [overviewDraft, setOverviewDraft] = useState(() => {
    const plateCamera = initialOverviewSetup?.plateCameras?.[0] || null;
    return {
      sourceCameraName: initialOverviewSetup?.status?.observedSources?.[0] || "",
      plateCameraName: plateCamera?.cameraName || "",
      directionLabel: plateCamera?.directions?.[0] || "",
      sourceRole: "primary",
      expectedDeltaMs: 0,
      toleranceMs: 1500,
      priority: 0,
      enabled: true,
    };
  });
  const profile = useMemo(
    () => data.profiles.find((item) => item.cameraName === cameraName) || data.profiles[0] || null,
    [cameraName, data.profiles]
  );
  const overviewPlateCamera = useMemo(
    () => overviewSetup?.plateCameras?.find((item) => item.cameraName === overviewDraft.plateCameraName)
      || overviewSetup?.plateCameras?.[0]
      || null,
    [overviewDraft.plateCameraName, overviewSetup?.plateCameras]
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

  useEffect(() => {
    if (!frameQueue?.pending && !frameQueue?.liveOutstanding && !frameQueue?.historicalOutstanding) return undefined;
    const timer = window.setInterval(async () => {
      const result = await getBlueIrisVehicleFrameQueueStatus();
      if (result.success) setFrameQueue(result.data);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [frameQueue?.historicalOutstanding, frameQueue?.liveOutstanding, frameQueue?.pending]);

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

  const reloadOverviewSetup = async () => {
    const result = await getVehicleOverviewSetup();
    if (!result.success) throw new Error(result.error);
    setOverviewSetup(result.data);
    return result.data;
  };

  const saveOverviewProfile = async () => {
    setBusy("overview-profile");
    setMessage("");
    try {
      const result = await saveVehicleOverviewPairProfile(overviewDraft);
      if (!result.success) throw new Error(result.error);
      await reloadOverviewSetup();
      setMessage("Overview timing and direction association saved.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const removeOverviewProfile = async (profileId) => {
    setBusy(`overview-delete:${profileId}`);
    setMessage("");
    try {
      const result = await deleteVehicleOverviewPairProfile(profileId);
      if (!result.success) throw new Error(result.error);
      await reloadOverviewSetup();
      setMessage("Overview association removed.");
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

  const toggleReevaluationPaused = async () => {
    const nextPaused = !data.backfill?.reevaluationPaused;
    setBusy(nextPaused ? "pause-reevaluation" : "resume-reevaluation");
    setMessage("");
    try {
      const result = await setVehicleDirectionReevaluationPaused(nextPaused);
      if (!result.success) throw new Error(result.error);
      await reload(cameraName);
      setMessage(nextPaused
        ? "Historical re-evaluation will pause after the current batch. New live reads will continue to be analyzed."
        : "Historical re-evaluation resumed. New live reads remain prioritized.");
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
    actionablePending: 0,
    newPending: 0,
    reevaluationPending: 0,
    reevaluationPaused: false,
    imagesAwaitingIndex: 0,
    imageFailures: 0,
  };
  const backfillCompletion = backfill.eligible
    ? Math.round(backfill.completed / backfill.eligible * 100)
    : 100;

  const queueFrameHistory = async (allCameras = false, replaceExisting = false) => {
    setBusy(replaceExisting ? "frame-history-reevaluate" : allCameras ? "frame-history-all" : "frame-history-camera");
    setFrameMessage("");
    try {
      const result = await queueBlueIrisVehicleFrameHistory({
        cameraName: allCameras ? null : cameraName,
        startDate: frameStartDate ? new Date(`${frameStartDate}T00:00:00`).toISOString() : null,
        endDate: frameEndDate ? new Date(`${frameEndDate}T23:59:59.999`).toISOString() : null,
        replaceExisting,
      });
      if (!result.success) throw new Error(result.error);
      setFrameQueue(result.data.status);
      setFrameMessage(replaceExisting
        ? `Queued ${result.data.queued.toLocaleString()} existing vehicle view${result.data.queued === 1 ? "" : "s"} for reevaluation. History remains paused until you explicitly resume it, and each prior image remains available until its replacement succeeds.`
        : `Queued ${result.data.queued.toLocaleString()} missing vehicle view${result.data.queued === 1 ? "" : "s"}. History remains paused until you explicitly resume it; live reads continue automatically.`);
    } catch (error) { setFrameMessage(error.message); }
    finally { setBusy(""); }
  };

  const cancelFrameHistory = async () => {
    setBusy("frame-history-cancel");
    setFrameMessage("");
    try {
      const result = await cancelBlueIrisVehicleFrameHistory({
        cameraName,
        startDate: frameStartDate ? new Date(`${frameStartDate}T00:00:00`).toISOString() : null,
        endDate: frameEndDate ? new Date(`${frameEndDate}T23:59:59.999`).toISOString() : null,
      });
      if (!result.success) throw new Error(result.error);
      setFrameQueue(result.data.status);
      setCancelFrameHistoryOpen(false);
      setFrameMessage(`Cancelled ${result.data.cancelled.toLocaleString()} pending historical vehicle-view job${result.data.cancelled === 1 ? "" : "s"} for ${cameraName || "the selected scope"}. Live work was not changed.`);
    } catch (error) { setFrameMessage(error.message); }
    finally { setBusy(""); }
  };

  const toggleFrameHistory = async () => {
    const nextPaused = frameQueue?.historicalPaused !== true;
    setBusy("frame-history-pause");
    setFrameMessage("");
    try {
      const result = await setBlueIrisVehicleFrameHistoryPaused(nextPaused);
      if (!result.success) throw new Error(result.error);
      setFrameQueue(result.data.status);
      setFrameMessage(nextPaused ? "Historical vehicle-frame processing paused. New live reads will continue." : "Historical vehicle-frame processing resumed.");
    } catch (error) { setFrameMessage(error.message); }
    finally { setBusy(""); }
  };

  const runFrameBatch = async () => {
    setBusy("frame-batch");
    setFrameMessage("");
    try {
      const result = await runBlueIrisVehicleFrameBatch();
      if (!result.success) throw new Error(result.error);
      setFrameQueue(result.data.status);
      setFrameMessage(result.data.batch.processed ? "Processed one Blue Iris vehicle-frame job." : "No eligible vehicle-frame job is waiting.");
    } catch (error) { setFrameMessage(error.message); }
    finally { setBusy(""); }
  };

  return (
    <SettingsShell
      activeId="vehicleIntelligence"
      title="Vehicle Setup"
      description="Configure camera behavior, vehicle views, processing, and calibration. Use Vehicle Intelligence for profiles and review work."
    >
      <Tabs value={routeTab.active} onValueChange={routeTab.navigate} className="space-y-6">
        <TabsList aria-label="Vehicle intelligence sections" className="grid h-auto w-full grid-cols-2 gap-1 p-1 lg:grid-cols-4">
          <TabsTrigger value="cameras" className="gap-2 py-2"><Settings2 className="h-4 w-4" />Cameras</TabsTrigger>
          <TabsTrigger value="views" className="gap-2 py-2">
            <Images className="h-4 w-4" />Vehicle Views
            {Number(frameQueue?.historicalOutstanding || 0) > 0 ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{compactCount(frameQueue.historicalOutstanding)}</span> : null}
          </TabsTrigger>
          <TabsTrigger value="processing" className="gap-2 py-2">
            <History className="h-4 w-4" />Processing
            {Number(data.backfill?.pending || 0) > 0 ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{compactCount(data.backfill.pending)}</span> : null}
          </TabsTrigger>
          <TabsTrigger value="calibration" className="gap-2 py-2"><ScanSearch className="h-4 w-4" />Calibration</TabsTrigger>
        </TabsList>

        {message && <p className="rounded-md border p-3 text-sm">{message}</p>}

        <TabsContent value="cameras" className="mt-0">
          <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><BrainCircuit className="h-5 w-5" /> Camera direction setup</CardTitle>
            <CardDescription>
              Daytime Blue Iris ordered zone crossings are the primary direction source for new reads. Single-frame Vehicle ReID is used only when a mapped crossing is unavailable. Monochrome nighttime captures show Unavailable nighttime, and no video clips are stored.
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
                    <div className="space-y-4 rounded-md border p-4 md:col-span-2">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-medium">Blue Iris zone-crossing direction</div>
                          <div className="text-xs text-muted-foreground">
                            Map the ordered &amp;TYPE value from the existing plate alert. New daytime mapped reads use this direction first; Vehicle ReID remains the fallback. Monochrome nighttime captures are not classified.
                          </div>
                        </div>
                        <Switch
                          checked={draft.blueIrisMotionEnabled === true}
                          onCheckedChange={(blueIrisMotionEnabled) => setDraft({ ...draft, blueIrisMotionEnabled })}
                          aria-label="Enable Blue Iris zone-crossing direction"
                        />
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="blue-iris-front-trigger">
                            Trigger meaning {draft.frontDirectionLabel || "front-view direction"}
                          </Label>
                          <Input
                            id="blue-iris-front-trigger"
                            value={draft.blueIrisFrontTriggerType || ""}
                            onChange={(event) => setDraft({ ...draft, blueIrisFrontTriggerType: event.target.value })}
                            placeholder="MOTION_A>B"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="blue-iris-rear-trigger">
                            Trigger meaning {draft.rearDirectionLabel || "rear-view direction"}
                          </Label>
                          <Input
                            id="blue-iris-rear-trigger"
                            value={draft.blueIrisRearTriggerType || ""}
                            onChange={(event) => setDraft({ ...draft, blueIrisRearTriggerType: event.target.value })}
                            placeholder="MOTION_B>A"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Configure Blue Iris with both ordered rules, for example A&gt;B,B&gt;A. The existing web request sends the crossing as <code>"trigger_type":"&amp;TYPE"</code>.
                      </p>
                      <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                        <div className="rounded-md border p-2"><div className="font-semibold">{Number(data.blueIrisTriggerDirection?.received || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">received</div></div>
                        <div className="rounded-md border p-2"><div className="font-semibold">{Number(data.blueIrisTriggerDirection?.ready || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">mapped</div></div>
                        <div className="rounded-md border p-2"><div className="font-semibold">{Number(data.blueIrisTriggerDirection?.unknown || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">unknown / unavailable</div></div>
                        <div className="rounded-md border p-2"><div className="font-semibold">{Number(data.blueIrisTriggerDirection?.unmapped || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">unmapped</div></div>
                      </div>
                      <p className="text-xs text-muted-foreground">Counts and observations are limited to {cameraName || "the selected camera"}.</p>
                      {data.blueIrisTriggerDirection?.recent?.length ? (
                        <details className="rounded-md border">
                          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Newest Blue Iris observations</summary>
                          <div className="overflow-x-auto border-t">
                            <table className="w-full min-w-[760px] text-left text-sm">
                              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                                <tr>
                                  <th className="px-3 py-2 font-medium">Plate</th>
                                  <th className="px-3 py-2 font-medium">Camera / time</th>
                                  <th className="px-3 py-2 font-medium">Blue Iris &amp;TYPE</th>
                                  <th className="px-3 py-2 font-medium">Mapped / displayed</th>
                                </tr>
                              </thead>
                              <tbody>
                                {data.blueIrisTriggerDirection.recent.map((read) => (
                                  <tr key={read.readId} className="border-b last:border-0">
                                    <td className="px-3 py-2 font-mono font-semibold">{read.plateNumber}</td>
                                    <td className="px-3 py-2">
                                      <div>{read.cameraName}</div>
                                      <div className="text-xs text-muted-foreground">{new Date(read.timestamp).toLocaleString()}</div>
                                    </td>
                                    <td className="px-3 py-2 font-mono">{read.triggerType || "Unavailable"}</td>
                                    <td className="px-3 py-2">
                                      <div>{read.status === "ready"
                                        ? read.directionLabel
                                        : read.errorCode === "MONOCHROME_NIGHT_DIRECTION_UNAVAILABLE"
                                          ? "Unavailable nighttime"
                                          : `Unknown: ${String(read.errorCode || "unresolved").toLowerCase().replaceAll("_", " ")}`}</div>
                                      <div className="text-xs text-muted-foreground">Current: {read.currentDirectionLabel || "not available"}</div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </details>
                      ) : null}
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
          </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="views" className="mt-0">
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Daytime overview retrieval</CardTitle>
              <CardDescription>
                Each daytime plate read uses its validated direction and camera-pair timing profile to retrieve Street Overview directly. Monochrome nighttime reads are skipped.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4 lg:grid-cols-8">
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.pending || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">candidates queued</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.processing || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">processing</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.awaitingMatch || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">awaiting plates</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.associated || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">associated</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.ambiguous || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">ambiguous</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.unavailable || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">unavailable</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.nighttimeSkipped || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">nighttime skipped</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.failed || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">failures</div></div>
              </div>

              <div className="rounded-lg border p-4">
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-2 lg:col-span-2">
                    <Label htmlFor="overview-source-camera">Overview source camera</Label>
                    <Input
                      id="overview-source-camera"
                      list="overview-source-cameras"
                      value={overviewDraft.sourceCameraName}
                      onChange={(event) => setOverviewDraft({ ...overviewDraft, sourceCameraName: event.target.value })}
                      placeholder="Example: Street Overview"
                    />
                    <datalist id="overview-source-cameras">
                      {(overviewSetup?.status?.observedSources || []).map((source) => <option key={source} value={source} />)}
                    </datalist>
                  </div>
                  <div className="space-y-2">
                    <Label>Plate camera</Label>
                    <Select
                      value={overviewDraft.plateCameraName}
                      onValueChange={(plateCameraName) => {
                        const selected = overviewSetup?.plateCameras?.find((item) => item.cameraName === plateCameraName);
                        setOverviewDraft({
                          ...overviewDraft,
                          plateCameraName,
                          directionLabel: selected?.directions?.[0] || "",
                        });
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Select a plate camera" /></SelectTrigger>
                      <SelectContent>
                        {(overviewSetup?.plateCameras || []).map((item) => <SelectItem key={item.cameraName} value={item.cameraName}>{item.cameraName}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Validated direction</Label>
                    <Select value={overviewDraft.directionLabel} onValueChange={(directionLabel) => setOverviewDraft({ ...overviewDraft, directionLabel })}>
                      <SelectTrigger><SelectValue placeholder="Select direction" /></SelectTrigger>
                      <SelectContent>
                        {(overviewPlateCamera?.directions || []).map((direction) => <SelectItem key={direction} value={direction}>{direction}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Source role</Label>
                    <Select value={overviewDraft.sourceRole} onValueChange={(sourceRole) => setOverviewDraft({ ...overviewDraft, sourceRole })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="primary">Primary overview</SelectItem>
                        <SelectItem value="fallback">Driveway fallback</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="overview-expected-delta">Expected delta (ms)</Label>
                    <Input id="overview-expected-delta" type="number" min="-30000" max="30000" value={overviewDraft.expectedDeltaMs} onChange={(event) => setOverviewDraft({ ...overviewDraft, expectedDeltaMs: Number(event.target.value) })} />
                    <p className="text-xs text-muted-foreground">Overview time minus plate-read time. Positive means Overview is later.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="overview-tolerance">Tolerance (ms)</Label>
                    <Input id="overview-tolerance" type="number" min="250" max={overviewDraft.sourceRole === "primary" ? 3000 : 10000} step="50" value={overviewDraft.toleranceMs} onChange={(event) => setOverviewDraft({ ...overviewDraft, toleranceMs: Number(event.target.value) })} />
                    <p className="text-xs text-muted-foreground">
                      Primary Overview uses exactly six seconds of 100 ms samples, so its tolerance is limited to 3000 ms.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="overview-priority">Priority</Label>
                    <Input id="overview-priority" type="number" min="0" max="100" value={overviewDraft.priority} onChange={(event) => setOverviewDraft({ ...overviewDraft, priority: Number(event.target.value) })} />
                  </div>
                  <div className="flex items-center justify-between rounded-md border px-3 py-2">
                    <div><div className="text-sm font-medium">Association enabled</div><div className="text-xs text-muted-foreground">Disable without deleting its history.</div></div>
                    <Switch checked={overviewDraft.enabled} onCheckedChange={(enabled) => setOverviewDraft({ ...overviewDraft, enabled })} />
                  </div>
                </div>
                <Button className="mt-4" onClick={saveOverviewProfile} disabled={Boolean(busy) || !overviewDraft.sourceCameraName || !overviewDraft.plateCameraName || !overviewDraft.directionLabel || overviewDraft.sourceCameraName.trim().toLowerCase() === overviewDraft.plateCameraName.trim().toLowerCase()}>
                  {busy === "overview-profile" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save overview association
                </Button>
              </div>

              {overviewSetup?.profiles?.length ? (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[900px] text-left text-sm">
                    <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                      <tr><th className="px-3 py-2">Source</th><th className="px-3 py-2">Plate camera</th><th className="px-3 py-2">Direction</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Expected / tolerance</th><th className="px-3 py-2">State</th><th className="px-3 py-2">Action</th></tr>
                    </thead>
                    <tbody>
                      {overviewSetup.profiles.map((item) => (
                        <tr key={item.id} className="border-b last:border-0">
                          <td className="px-3 py-2">{item.sourceCameraName}</td>
                          <td className="px-3 py-2">{item.plateCameraName}</td>
                          <td className="px-3 py-2">{item.directionLabel}</td>
                          <td className="px-3 py-2 capitalize">{item.sourceRole}</td>
                          <td className="px-3 py-2 font-mono">{item.expectedDeltaMs} ms / ±{item.toleranceMs} ms</td>
                          <td className="px-3 py-2">{item.enabled ? "Enabled" : "Disabled"}</td>
                          <td className="px-3 py-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={Boolean(busy)}
                              onClick={() => setOverviewDraft({ ...item })}
                            >
                              <Settings2 className="h-4 w-4" />
                              <span className="sr-only">Edit overview association</span>
                            </Button>
                            <Button type="button" size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => removeOverviewProfile(item.id)}>
                              {busy === `overview-delete:${item.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                              <span className="sr-only">Delete overview association</span>
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="text-sm text-muted-foreground">No overview timing profiles are configured yet.</p>}

              <div className="rounded-md border p-3 text-sm">
                <div className="font-medium">No Street Overview alert action required</div>
                <p className="mt-1 text-xs text-muted-foreground">ALPR retrieves the configured Street Overview timeline directly after a daytime plate read. Do not add a separate Blue Iris motion web request for this feature.</p>
              </div>
            </CardContent>
          </Card>
          <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Images className="h-5 w-5" /> Blue Iris vehicle views</CardTitle>
            <CardDescription>
              New daytime reads use the overview association above. These controls retain the older plate-camera selector only for historical jobs and deliberate manual recovery; it no longer supplies normal live Vehicle Views.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!frameQueue?.configured && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">Configure and test Blue Iris before vehicle views can be extracted.</p>
            )}
            {frameQueue?.configured && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
                <div>
                  <div className="font-medium">
                    Live worker: {{
                      starting: "Starting",
                      processing: "Processing a read",
                      sleeping: "Running",
                      idle: "Idle",
                      busy: "Already processing",
                      error: "Needs attention",
                      "not-configured": "Blue Iris not configured",
                      stopped: "Stopped",
                    }[frameQueue?.worker?.phase] || "Running"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Live reads continue automatically even when historical processing is paused.
                  </div>
                </div>
                <Badge variant={frameQueue?.worker?.phase === "error" ? "destructive" : "secondary"}>
                  {Number(frameQueue?.liveOutstanding || 0).toLocaleString()} live waiting
                </Badge>
              </div>
            )}
            {frameQueue?.worker?.lastError?.message ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                Blue Iris worker error: {frameQueue.worker.lastError.message}
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-5">
              <div className="rounded-md border p-3"><div className="text-xl font-semibold">{Number(frameQueue?.ready || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">vehicle views ready</div></div>
              <div className="rounded-md border p-3"><div className="text-xl font-semibold">{Number(frameQueue?.pending || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">processing or queued</div></div>
              <div className="rounded-md border p-3"><div className="text-xl font-semibold">{Number(frameQueue?.historicalMissing || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">history not queued</div></div>
              <div className="rounded-md border p-3"><div className="text-xl font-semibold">{Number(frameQueue?.unavailable || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">unavailable views</div></div>
              <div className="rounded-md border p-3"><div className="text-xl font-semibold">{Number(frameQueue?.failed || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">retry failures</div></div>
            </div>
            <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label>Camera for vehicle-view history</Label>
                <Select value={cameraName} onValueChange={selectCamera}>
                  <SelectTrigger><SelectValue placeholder="Select a camera" /></SelectTrigger>
                  <SelectContent>
                    {data.profiles.map((item) => <SelectItem key={item.cameraName} value={item.cameraName}>{item.cameraName}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">This camera is used only by the camera-specific history button below. New live reads are processed automatically for every configured camera.</p>
              </div>
              <details className="rounded-md border sm:col-span-2">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Optional date range</summary>
                <div className="grid gap-3 border-t p-3 sm:grid-cols-2">
                  <div className="space-y-2"><Label htmlFor="frame-history-start">History start</Label><Input id="frame-history-start" type="date" value={frameStartDate} onChange={(event) => setFrameStartDate(event.target.value)} /></div>
                  <div className="space-y-2"><Label htmlFor="frame-history-end">History end</Label><Input id="frame-history-end" type="date" value={frameEndDate} onChange={(event) => setFrameEndDate(event.target.value)} /></div>
                </div>
              </details>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <Button variant="outline" disabled={Boolean(busy) || !cameraName || !frameQueue?.configured} onClick={() => queueFrameHistory(false)}>{busy === "frame-history-camera" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Queue {cameraName || "selected camera"} history</Button>
                <Button variant="outline" disabled={Boolean(busy) || !frameQueue?.configured} onClick={() => queueFrameHistory(true)}>{busy === "frame-history-all" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Queue all camera history</Button>
                <Button variant="outline" disabled={Boolean(busy) || !frameQueue?.configured} onClick={() => queueFrameHistory(true, true)}>{busy === "frame-history-reevaluate" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Reevaluate existing views</Button>
                <Button variant="secondary" disabled={Boolean(busy) || !frameQueue?.configured} onClick={toggleFrameHistory}>{frameQueue?.historicalPaused ? <Play className="mr-2 h-4 w-4" /> : <Pause className="mr-2 h-4 w-4" />}{frameQueue?.historicalPaused ? "Resume history" : "Pause history"}</Button>
                <Button variant="destructive" disabled={Boolean(busy) || !cameraName || !frameQueue?.historicalOutstanding} onClick={() => setCancelFrameHistoryOpen(true)}><XCircle className="mr-2 h-4 w-4" />Cancel pending {cameraName || "camera"} history</Button>
                <Button variant="secondary" disabled={Boolean(busy) || !frameQueue?.configured} onClick={runFrameBatch}>{busy === "frame-batch" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}Run one frame now</Button>
              </div>
            </div>
            {frameMessage && <p className="rounded-md border p-3 text-sm">{frameMessage}</p>}
          </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="processing" className="mt-0">
          <Card>
          <CardHeader>
            <CardTitle>Historical direction backfill</CardTitle>
            <CardDescription>
              Existing image-backed reads are indexed and evaluated in safe, resumable batches. Human front/rear reviews remain authoritative, and this process does not send historical notifications.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 rounded-lg border p-4">
              <Label>Camera for selected re-evaluation</Label>
              <Select value={cameraName} onValueChange={selectCamera}>
                <SelectTrigger><SelectValue placeholder="Select a camera" /></SelectTrigger>
                <SelectContent>
                  {data.profiles.map((item) => <SelectItem key={item.cameraName} value={item.cameraName}>{item.cameraName}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">This selection affects only the camera-specific re-evaluation action. The all-cameras action remains separate.</p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span>{backfill.completed.toLocaleString()} of {backfill.eligible.toLocaleString()} indexed captures completed</span>
              <Badge variant={backfill.pending ? "outline" : "secondary"}>
                {backfill.reevaluationPaused && backfill.reevaluationPending
                  ? `${backfill.reevaluationPending.toLocaleString()} re-evaluations paused`
                  : backfill.pending ? `${backfill.pending.toLocaleString()} pending` : "Up to date"}
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
              New live reads are processed before historical re-evaluations. Existing direction assignments stay visible until their replacements are ready. Captures below the confidence threshold correctly remain Unknown.
            </p>
            <Button
              variant="secondary"
              onClick={runDirectionBackfill}
              disabled={Boolean(busy) || Number(backfill.actionablePending ?? backfill.pending) === 0}
            >
              {busy === "backfill" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Run one direction batch now
            </Button>
            <details className="rounded-lg border">
              <summary className="cursor-pointer p-4 font-medium">Advanced: re-evaluate completed history</summary>
              <div className="border-t p-4">
                <div className="space-y-1">
                <p className="text-sm text-muted-foreground">
                  Apply the latest front/rear examples to earlier machine-generated results. Human-reviewed directions remain unchanged, and historical notifications are never sent.
                </p>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                {backfill.reevaluationPending > 0 && (
                  <Button
                    variant={backfill.reevaluationPaused ? "default" : "secondary"}
                    onClick={toggleReevaluationPaused}
                    disabled={Boolean(busy)}
                  >
                    {busy === "pause-reevaluation" || busy === "resume-reevaluation"
                      ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      : backfill.reevaluationPaused
                        ? <Play className="mr-2 h-4 w-4" />
                        : <Pause className="mr-2 h-4 w-4" />}
                    {backfill.reevaluationPaused ? "Resume re-evaluation" : "Pause re-evaluation"}
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => openReevaluation(cameraName)}
                  disabled={Boolean(busy) || !profile}
                >
                  {busy === "preview-camera" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                  Re-evaluate {cameraName || "selected camera"}...
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
            </details>
          </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="calibration" className="mt-0">
          {profile ? (
            <Card>
            <CardHeader>
              <CardTitle>Front/rear calibration</CardTitle>
              <CardDescription>
                Label at least {data.minimumSamplesPerView} clear front views and {data.minimumSamplesPerView} clear rear views for this camera. More varied examples improve reliability.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Camera</Label>
                <Select value={cameraName} onValueChange={selectCamera}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {data.profiles.map((item) => <SelectItem key={item.cameraName} value={item.cameraName}>{item.cameraName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
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
          ) : (
            <Card><CardContent className="p-6 text-sm text-muted-foreground">No cameras with plate reads are available yet.</CardContent></Card>
          )}
        </TabsContent>
      </Tabs>
      <AlertDialog open={cancelFrameHistoryOpen} onOpenChange={(open) => { if (busy !== "frame-history-cancel") setCancelFrameHistoryOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel pending historical vehicle views?</AlertDialogTitle>
            <AlertDialogDescription>
              This pauses history and removes only pending or retryable historical jobs for {cameraName || "the selected camera"}{frameStartDate || frameEndDate ? " within the selected date range" : ""}. Live reads, completed vehicle images, and manual retries are preserved. One frame already in progress may still finish.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "frame-history-cancel"}>Keep jobs</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => { event.preventDefault(); cancelFrameHistory(); }} disabled={busy === "frame-history-cancel"}>
              {busy === "frame-history-cancel" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
              Cancel pending history
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
                  <div className="rounded-md border p-3"><strong>{reevaluationPreview?.previousReady?.toLocaleString() || 0}</strong><br />assigned results retained while queued</div>
                  <div className="rounded-md border p-3"><strong>{reevaluationPreview?.previousUnknown?.toLocaleString() || 0}</strong><br />Unknown results retried</div>
                </div>
                <p>
                  {reevaluationPreview?.manualPreserved?.toLocaleString() || 0} human-reviewed front/rear result{reevaluationPreview?.manualPreserved === 1 ? "" : "s"} will be preserved. Current machine results remain visible until replacements are ready. Processing is resumable, pausable, and does not send historical notifications.
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
