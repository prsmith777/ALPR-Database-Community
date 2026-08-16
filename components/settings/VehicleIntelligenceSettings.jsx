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
  saveVehicleEntryOverviewHistoryProfiles,
  saveVehicleEntryRouteProfile,
  setVehicleOverviewPairSharingMode,
  setVehicleEntryFallbackMode,
  deleteVehicleOverviewPairProfile,
  deleteVehicleEntryRouteProfile,
  cancelBlueIrisVehicleFrameHistory,
  queueBlueIrisVehicleFrameHistory,
  recoverBlueIrisCompositeTriggerReads,
  recoverIncompleteBlueIrisOverviewReads,
  previewVehicleEntryOverviewHistory,
  confirmVehicleEntryOverviewHistory,
  setVehicleEntryOverviewHistoryPaused,
  cancelVehicleEntryOverviewHistory,
  retryVehicleEntryOverviewHistoryImport,
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
import VehicleImageAssetCatalogPanel from "@/components/settings/VehicleImageAssetCatalogPanel";
import VehicleEventShadowPanel from "@/components/settings/VehicleEventShadowPanel";
import VehicleImageCropPanel from "@/components/settings/VehicleImageCropPanel";
import VehicleAssetEmbeddingPanel from "@/components/settings/VehicleAssetEmbeddingPanel";
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

const ENTRY_OVERVIEW_HISTORY_CAMERAS = Object.freeze([
  "Entry LPR 1",
  "Entry LPR 2",
]);
const ENTRY_OVERVIEW_SOURCE_CAMERA = "Entry Overview";
const ENTRY_OVERVIEW_SOURCE_SHORT_NAME = "Cam143";

function entryOverviewHistoryDeltas(profiles = []) {
  return Object.fromEntries(ENTRY_OVERVIEW_HISTORY_CAMERAS.map((plateCameraName) => {
    const profile = profiles.find((item) => item.plateCameraName === plateCameraName);
    return [plateCameraName, profile ? String(profile.expectedDeltaMs) : ""];
  }));
}

function validEntryOverviewHistoryDelta(value) {
  if (String(value ?? "").trim() === "") return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && Math.abs(number) <= 30_000;
}

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

function localDateTimeInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export default function VehicleIntelligenceSettings({
  initialData,
  initialFrameQueue = null,
  initialOverviewSetup = null,
  initialVehicleImageCatalog = null,
  initialVehicleEventShadow = null,
  initialVehicleImageCrops = null,
  initialVehicleAssetEmbeddings = null,
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
  const [overviewRecoveryStart, setOverviewRecoveryStart] = useState("");
  const [overviewRecoveryPreview, setOverviewRecoveryPreview] = useState(null);
  const [triggerRecoveryStart, setTriggerRecoveryStart] = useState("");
  const [triggerRecoveryPreview, setTriggerRecoveryPreview] = useState(null);
  const [cancelFrameHistoryOpen, setCancelFrameHistoryOpen] = useState(false);
  const [overviewSetup, setOverviewSetup] = useState(initialOverviewSetup);
  const [entryHistoryDeltas, setEntryHistoryDeltas] = useState(() => (
    entryOverviewHistoryDeltas(initialOverviewSetup?.entryOverviewHistory?.profiles)
  ));
  const [entryHistoryStart, setEntryHistoryStart] = useState("");
  const [entryHistoryEnd, setEntryHistoryEnd] = useState("");
  const [entryHistoryBatchSize, setEntryHistoryBatchSize] = useState("5");
  const [entryHistoryRun, setEntryHistoryRun] = useState(
    initialOverviewSetup?.entryOverviewHistory?.latestRun
      || initialFrameQueue?.entryOverviewHistoryRun
      || null
  );
  const [entryHistoryRetryCandidates, setEntryHistoryRetryCandidates] = useState(
    initialOverviewSetup?.entryOverviewHistory?.retryCandidates
      || initialFrameQueue?.entryOverviewHistoryRetryCandidates
      || []
  );
  const [entryHistoryMessage, setEntryHistoryMessage] = useState("");
  const [pairSharingMode, setPairSharingMode] = useState(
    initialOverviewSetup?.status?.pairSharing?.mode || "off"
  );
  const [entryFallbackMode, setEntryFallbackMode] = useState(
    initialOverviewSetup?.entryFallback?.mode || "off"
  );
  const [entryFallbackPayloadMode, setEntryFallbackPayloadMode] = useState(
    initialOverviewSetup?.entryFallback?.overviewPayloadMode || "shadow"
  );
  const [entryFallbackStart, setEntryFallbackStart] = useState(
    localDateTimeInput(initialOverviewSetup?.entryFallback?.observationStartedAt)
  );
  const [entryRouteDraft, setEntryRouteDraft] = useState(() => {
    const cameras = initialOverviewSetup?.plateCameras || [];
    const target = cameras[0] || null;
    const sourceOne = cameras[1] || null;
    const sourceTwo = cameras[2] || null;
    return {
      routeName: "",
      targetCameraName: target?.cameraName || "",
      targetDirectionLabel: target?.directions?.[0] || "",
      sourceCameraNames: [sourceOne?.cameraName || "", sourceTwo?.cameraName || ""],
      sourceDirectionLabel: sourceOne?.directions?.[0] || "",
      expectedDeltaMs: 10_000,
      toleranceMs: 3_000,
      eventWindowMs: 3_000,
      priority: 0,
      enabled: true,
    };
  });
  const [overviewDraft, setOverviewDraft] = useState(() => {
    const plateCamera = initialOverviewSetup?.plateCameras?.[0] || null;
    return {
      sourceCameraName: initialOverviewSetup?.status?.observedSources?.[0] || "",
      sourceCameraShortName: "",
      plateCameraName: plateCamera?.cameraName || "",
      directionLabel: plateCamera?.directions?.[0] || "",
      sourceRole: "primary",
      overviewContext: "street",
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
    setPairSharingMode(overviewSetup?.status?.pairSharing?.mode || "off");
  }, [overviewSetup?.status?.pairSharing?.mode]);

  useEffect(() => {
    setEntryFallbackMode(overviewSetup?.entryFallback?.mode || "off");
    setEntryFallbackPayloadMode(overviewSetup?.entryFallback?.overviewPayloadMode || "shadow");
    setEntryFallbackStart(localDateTimeInput(overviewSetup?.entryFallback?.observationStartedAt));
  }, [overviewSetup?.entryFallback?.mode, overviewSetup?.entryFallback?.observationStartedAt, overviewSetup?.entryFallback?.overviewPayloadMode]);

  useEffect(() => {
    setEntryHistoryDeltas(entryOverviewHistoryDeltas(overviewSetup?.entryOverviewHistory?.profiles));
  }, [overviewSetup?.entryOverviewHistory?.profiles]);

  useEffect(() => {
    const pending = Number(data.backfill?.pending || 0)
      + Number(data.backfill?.imagesAwaitingIndex || 0);
    if (!pending) return undefined;
    const timer = window.setInterval(async () => {
      const result = await getVehicleDirectionSetup(cameraName, {
        includeBackfill: true,
        includeCaptures: false,
        includeBlueIrisTriggerDirection: false,
      });
      if (result.success) setData(result.data);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [cameraName, data.backfill?.imagesAwaitingIndex, data.backfill?.pending]);

  useEffect(() => {
    const entryHistoryActiveJobs = Number(entryHistoryRun?.counts?.queued || 0)
      + Number(entryHistoryRun?.counts?.processing || 0);
    const entryHistoryPolling = ["running", "paused"].includes(entryHistoryRun?.status)
      && entryHistoryActiveJobs > 0;
    if (!frameQueue?.pending
      && !frameQueue?.liveOutstanding
      && !frameQueue?.historicalOutstanding
      && !entryHistoryPolling) return undefined;
    const timer = window.setInterval(async () => {
      const result = await getBlueIrisVehicleFrameQueueStatus({
        entryOverviewHistoryRunId: entryHistoryRun?.id || null,
      });
      if (result.success) {
        setFrameQueue(result.data);
        if (Array.isArray(result.data.entryOverviewHistoryRetryCandidates)) {
          setEntryHistoryRetryCandidates(result.data.entryOverviewHistoryRetryCandidates);
        }
        if (result.data.entryOverviewHistoryRun) {
          setEntryHistoryRun(result.data.entryOverviewHistoryRun);
        }
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [
    entryHistoryRun?.counts?.processing,
    entryHistoryRun?.counts?.queued,
    entryHistoryRun?.id,
    entryHistoryRun?.status,
    frameQueue?.historicalOutstanding,
    frameQueue?.liveOutstanding,
    frameQueue?.pending,
  ]);

  const reload = async (selected = cameraName) => {
    const active = routeTab.active;
    const result = await getVehicleDirectionSetup(selected, {
      includeBackfill: active === "processing",
      includeCaptures: active === "calibration",
      includeBlueIrisTriggerDirection: active === "cameras",
    });
    if (!result.success) throw new Error(result.error);
    setData(result.data);
    setCameraName(result.data.selectedCamera || selected);
  };

  const selectCamera = async (value) => {
    setCameraName(value);
    if (routeTab.active === "views") return;
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
    setEntryHistoryRetryCandidates(result.data.entryOverviewHistory?.retryCandidates || []);
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

  const saveEntryHistoryProfiles = async () => {
    setBusy("entry-history-profiles");
    setEntryHistoryMessage("");
    try {
      const result = await saveVehicleEntryOverviewHistoryProfiles({
        profiles: ENTRY_OVERVIEW_HISTORY_CAMERAS.map((plateCameraName) => ({
          plateCameraName,
          expectedDeltaMs: Number(entryHistoryDeltas[plateCameraName]),
        })),
      });
      if (!result.success) throw new Error(result.error);
      setOverviewSetup((current) => ({
        ...current,
        entryOverviewHistory: {
          ...current?.entryOverviewHistory,
          ...result.data,
        },
      }));
      setEntryHistoryRun(null);
      setEntryHistoryMessage("Entry Overview timeline anchors saved. Preview the exact date range before confirming any work.");
    } catch (error) { setEntryHistoryMessage(error.message); }
    finally { setBusy(""); }
  };

  const previewEntryHistory = async () => {
    setBusy("entry-history-preview");
    setEntryHistoryMessage("");
    try {
      const startAt = new Date(entryHistoryStart);
      const endAt = new Date(entryHistoryEnd);
      if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime())) {
        throw new Error("Choose both an Entry Overview history start and end.");
      }
      const result = await previewVehicleEntryOverviewHistory({
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      });
      if (!result.success) throw new Error(result.error);
      setEntryHistoryRun(result.data.run);
      setEntryHistoryMessage("Preview complete. No reads were queued or changed.");
    } catch (error) { setEntryHistoryMessage(error.message); }
    finally { setBusy(""); }
  };

  const confirmEntryHistory = async () => {
    if (!entryHistoryRun) return;
    setBusy("entry-history-confirm");
    setEntryHistoryMessage("");
    try {
      const result = await confirmVehicleEntryOverviewHistory({
        runId: entryHistoryRun.id,
        previewFingerprint: entryHistoryRun.previewFingerprint,
        limit: Number(entryHistoryBatchSize),
      });
      if (!result.success) throw new Error(result.error);
      setEntryHistoryRun(result.data.run);
      setEntryHistoryMessage(
        `Confirmed ${Number(result.data.confirmation.queued || 0).toLocaleString()} read${result.data.confirmation.queued === 1 ? "" : "s"}. Live Vehicle Views remain first in line.`
      );
    } catch (error) { setEntryHistoryMessage(error.message); }
    finally { setBusy(""); }
  };

  const toggleEntryHistoryPaused = async () => {
    if (!entryHistoryRun) return;
    const paused = entryHistoryRun.status !== "paused";
    setBusy("entry-history-pause");
    setEntryHistoryMessage("");
    try {
      const result = await setVehicleEntryOverviewHistoryPaused({
        runId: entryHistoryRun.id,
        paused,
      });
      if (!result.success) throw new Error(result.error);
      setEntryHistoryRun(result.data.run);
      setEntryHistoryMessage(paused
        ? "Entry Overview history paused. Live work continues normally."
        : "Entry Overview history resumed behind live work.");
    } catch (error) { setEntryHistoryMessage(error.message); }
    finally { setBusy(""); }
  };

  const cancelEntryHistory = async () => {
    if (!entryHistoryRun) return;
    setBusy("entry-history-cancel");
    setEntryHistoryMessage("");
    try {
      const result = await cancelVehicleEntryOverviewHistory({ runId: entryHistoryRun.id });
      if (!result.success) throw new Error(result.error);
      setEntryHistoryRun(result.data.run);
      setEntryHistoryMessage(
        `Cancelled ${Number(result.data.cancellation.cancelled || 0).toLocaleString()} pending read${result.data.cancellation.cancelled === 1 ? "" : "s"}; prior images were preserved or restored.`
      );
    } catch (error) { setEntryHistoryMessage(error.message); }
    finally { setBusy(""); }
  };

  const retryEntryHistoryImport = async (jobId) => {
    setBusy(`entry-history-retry-${jobId}`);
    setEntryHistoryMessage("");
    try {
      const result = await retryVehicleEntryOverviewHistoryImport({ jobId });
      if (!result.success) throw new Error(result.error);
      if (result.data.run) setEntryHistoryRun(result.data.run);
      setEntryHistoryRetryCandidates(result.data.retryCandidates || []);
      setEntryHistoryMessage(
        "The failed import was queued for one bounded retry cycle. Its existing image, if any, remains in place until a validated replacement is ready."
      );
    } catch (error) { setEntryHistoryMessage(error.message); }
    finally { setBusy(""); }
  };

  const savePairSharingMode = async () => {
    setBusy("overview-pair-sharing");
    setMessage("");
    try {
      const result = await setVehicleOverviewPairSharingMode(pairSharingMode);
      if (!result.success) throw new Error(result.error);
      await reloadOverviewSetup();
      setMessage(pairSharingMode === "active"
        ? "Companion overview sharing is active. Only one-to-one validated primary matches can fill safe companion failures."
        : pairSharingMode === "shadow"
          ? "Companion overview sharing is observing proposals only; no read or image is changed."
          : "Companion overview sharing is paused.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const saveEntryFallbackMode = async () => {
    setBusy("entry-fallback-mode");
    setMessage("");
    try {
      const result = await setVehicleEntryFallbackMode({
        mode: entryFallbackMode,
        overviewPayloadMode: entryFallbackPayloadMode,
        observationStartedAt: entryFallbackStart || null,
      });
      if (!result.success) throw new Error(result.error);
      await reloadOverviewSetup();
      setMessage(entryFallbackMode === "active" && entryFallbackPayloadMode === "active"
        ? "Guarded driveway fallback is active. Dual Entry LPR evidence is preferred; a single direction-authoritative read may qualify only under the strict identity, timing, and ambiguity checks."
        : entryFallbackMode === "shadow"
          ? "Guarded driveway fallback is observing route matches only; no image is changed."
          : entryFallbackPayloadMode !== "active"
            ? "Route matching was saved, but Cam143 payload copying remains guarded in Off or Shadow mode."
          : "Paired-camera fallback is paused.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const saveEntryRoute = async () => {
    setBusy("entry-route");
    setMessage("");
    try {
      const result = await saveVehicleEntryRouteProfile(entryRouteDraft);
      if (!result.success) throw new Error(result.error);
      await reloadOverviewSetup();
      setMessage("Paired-camera route saved. Shadow matching will evaluate only existing eligible target reads.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const removeEntryRoute = async (profileId) => {
    setBusy(`entry-route-delete:${profileId}`);
    setMessage("");
    try {
      const result = await deleteVehicleEntryRouteProfile(profileId);
      if (!result.success) throw new Error(result.error);
      await reloadOverviewSetup();
      setMessage("Paired-camera route removed.");
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
  const entryHistoryProfiles = overviewSetup?.entryOverviewHistory?.profiles || [];
  const entryHistoryProfilesConfigured = ENTRY_OVERVIEW_HISTORY_CAMERAS.every(
    (plateCameraName) => entryHistoryProfiles.some((item) => (
      item.plateCameraName === plateCameraName && item.enabled === true
    ))
  );
  const entryHistoryDeltasValid = ENTRY_OVERVIEW_HISTORY_CAMERAS.every(
    (plateCameraName) => validEntryOverviewHistoryDelta(entryHistoryDeltas[plateCameraName])
  );
  const entryHistoryProfilesDirty = ENTRY_OVERVIEW_HISTORY_CAMERAS.some((plateCameraName) => {
    const saved = entryHistoryProfiles.find((item) => item.plateCameraName === plateCameraName);
    return !saved || Number(saved.expectedDeltaMs) !== Number(entryHistoryDeltas[plateCameraName]);
  });
  const entryHistoryRangeValid = Boolean(entryHistoryStart && entryHistoryEnd)
    && new Date(entryHistoryEnd).getTime() > new Date(entryHistoryStart).getTime();
  const entryHistoryCounts = entryHistoryRun?.counts || {};
  const entryHistoryBatchActive = Number(entryHistoryCounts.queued || 0)
    + Number(entryHistoryCounts.processing || 0) > 0;
  const entryHistoryConfirmable = Number(entryHistoryCounts.eligible || 0)
    + Number(entryHistoryCounts.needsPreflight || 0);
  const entryHistoryRemaining = Number(entryHistoryCounts.previewableRemaining || 0);
  const entryHistoryFinished = Number(entryHistoryCounts.ready || 0)
    + Number(entryHistoryCounts.failed || 0)
    + Number(entryHistoryCounts.unavailable || 0)
    + Number(entryHistoryCounts.superseded || 0)
    + Number(entryHistoryCounts.cancelled || 0);
  const entryHistoryProgress = entryHistoryConfirmable
    ? Math.min(100, Math.round(entryHistoryFinished / entryHistoryConfirmable * 100))
    : 0;
  const genericFrameHistoryProfiles = (data.profiles || []).filter(
    (profile) => !ENTRY_OVERVIEW_HISTORY_CAMERAS.includes(profile.cameraName)
  );
  const genericFrameHistoryCameraAllowed = genericFrameHistoryProfiles.some(
    (profile) => profile.cameraName === cameraName
  );

  const queueFrameHistory = async (allCameras = false, replaceExisting = false) => {
    setBusy(replaceExisting ? "frame-history-reevaluate" : allCameras ? "frame-history-all" : "frame-history-camera");
    setFrameMessage("");
    try {
      if (allCameras && entryHistoryProfilesConfigured) {
        throw new Error("All-camera history is disabled while Entry Overview history is configured. Use the previewed Entry Overview batches and a specific non-Entry camera instead.");
      }
      if (!allCameras && !genericFrameHistoryCameraAllowed) {
        throw new Error("Select a non-Entry camera. Entry LPR history uses the previewed Entry Overview workflow above.");
      }
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

  const recoverIncompleteOverview = async () => {
    setBusy("overview-recovery");
    setFrameMessage("");
    try {
      const recoveryStart = new Date(overviewRecoveryStart);
      if (!Number.isFinite(recoveryStart.getTime())) throw new Error("Choose a valid recovery start time.");
      if (!overviewRecoveryPreview || overviewRecoveryPreview.startAt !== recoveryStart.toISOString()) {
        throw new Error("Preview this exact recovery range before queuing it.");
      }
      const result = await recoverIncompleteBlueIrisOverviewReads({ startAt: recoveryStart.toISOString() });
      if (!result.success) throw new Error(result.error);
      setFrameQueue(result.data.status);
      setOverviewRecoveryPreview(null);
      setFrameMessage(`Queued ${result.data.queued.toLocaleString()} incomplete overview Vehicle View${result.data.queued === 1 ? "" : "s"} from ${new Date(result.data.startAt).toLocaleString()}. Ready images and terminal scene decisions were preserved.`);
    } catch (error) { setFrameMessage(error.message); }
    finally { setBusy(""); }
  };

  const previewIncompleteOverview = async () => {
    setBusy("overview-recovery-preview");
    setFrameMessage("");
    try {
      const recoveryStart = new Date(overviewRecoveryStart);
      if (!Number.isFinite(recoveryStart.getTime())) throw new Error("Choose a valid recovery start time.");
      const result = await recoverIncompleteBlueIrisOverviewReads({
        startAt: recoveryStart.toISOString(),
        previewOnly: true,
      });
      if (!result.success) throw new Error(result.error);
      setOverviewRecoveryPreview(result.data.preview);
      setFrameMessage(`Preview found ${result.data.preview.eligible.toLocaleString()} eligible incomplete overview Vehicle View${result.data.preview.eligible === 1 ? "" : "s"}. Nothing was changed.`);
    } catch (error) { setFrameMessage(error.message); }
    finally { setBusy(""); }
  };

  const previewCompositeTriggerRecovery = async () => {
    setBusy("trigger-recovery-preview");
    setFrameMessage("");
    try {
      const recoveryStart = new Date(triggerRecoveryStart);
      if (!Number.isFinite(recoveryStart.getTime())) throw new Error("Choose a valid trigger recovery start time.");
      const result = await recoverBlueIrisCompositeTriggerReads({
        startAt: recoveryStart.toISOString(),
        previewOnly: true,
      });
      if (!result.success) throw new Error(result.error);
      setTriggerRecoveryPreview(result.data.preview);
      setFrameMessage(`Preview found ${result.data.preview.eligible.toLocaleString()} exact read${result.data.preview.eligible === 1 ? "" : "s"} whose retained Blue Iris 6 trigger can safely restore direction and queue an overview. Nothing was changed.${result.data.preview.moreAvailable ? " Preview and run another batch afterward for the remaining reads." : ""}`);
    } catch (error) { setFrameMessage(error.message); }
    finally { setBusy(""); }
  };

  const recoverCompositeTriggers = async () => {
    setBusy("trigger-recovery");
    setFrameMessage("");
    try {
      if (!triggerRecoveryPreview?.readIds?.length) {
        throw new Error("Preview the exact trigger recovery batch before queuing it.");
      }
      const result = await recoverBlueIrisCompositeTriggerReads({
        startAt: triggerRecoveryPreview.startAt,
        endAt: triggerRecoveryPreview.endAt,
        readIds: triggerRecoveryPreview.readIds,
      });
      if (!result.success) throw new Error(result.error);
      setFrameQueue(result.data.status);
      setTriggerRecoveryPreview(null);
      setFrameMessage(`Restored direction and queued overview Vehicle Views for ${result.data.queued.toLocaleString()} read${result.data.queued === 1 ? "" : "s"}.${result.data.stale ? ` ${result.data.stale.toLocaleString()} previewed read${result.data.stale === 1 ? " was" : "s were"} no longer eligible and remained unchanged.` : ""} Historical notifications were not replayed.`);
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
                Each daytime plate read uses its validated direction and timing profile to retrieve the configured Street or Entry overview camera directly. Monochrome nighttime reads are skipped.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4 lg:grid-cols-8">
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.pending || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">reads queued</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.processing || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">processing</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.ready || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">views ready</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.ambiguous || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">ambiguous</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.unavailable || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">unavailable</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.nighttimeSkipped || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">nighttime skipped</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.failed || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">failures</div></div>
                <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.exports?.automaticStarts || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">BI exports started</div></div>
              </div>

              {overviewSetup?.status?.recentJobs?.length ? (
                <details className="rounded-md border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">Recent overview pipeline diagnostics</summary>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[1050px] text-left text-xs">
                      <thead className="border-b text-muted-foreground">
                        <tr><th className="px-2 py-2">Read</th><th className="px-2 py-2">Plate camera</th><th className="px-2 py-2">View source</th><th className="px-2 py-2">Read state</th><th className="px-2 py-2">Attempts</th><th className="px-2 py-2">Export state</th><th className="px-2 py-2">BI starts</th><th className="px-2 py-2">Media</th><th className="px-2 py-2">Error</th></tr>
                      </thead>
                      <tbody>
                        {overviewSetup.status.recentJobs.map((job) => (
                          <tr key={job.readId} className="border-b last:border-0">
                            <td className="px-2 py-2 font-mono">#{job.readId} {job.plateNumber || ""}</td>
                            <td className="px-2 py-2">{job.cameraName || "Unknown"}</td>
                            <td className="px-2 py-2">
                              {job.sourceCameraName || (job.overviewContext === "entry" ? "Entry overview" : "Street overview")}
                              {job.sourceCameraId ? <span className="ml-1 text-muted-foreground">({job.sourceCameraId})</span> : null}
                              {job.profileRevision ? <span className="block text-muted-foreground">profile r{job.profileRevision}</span> : null}
                            </td>
                            <td className="px-2 py-2">{job.readStatus || "Not queued"}</td>
                            <td className="px-2 py-2">{job.attemptCount} / recovery {job.recoveryCount}</td>
                            <td className="px-2 py-2">{job.exportStatus || "No export"}</td>
                            <td className="px-2 py-2">{job.automaticStartCount}</td>
                            <td className="px-2 py-2">{job.width && job.height ? `${job.width}x${job.height}` : "Not validated"}</td>
                            <td className="px-2 py-2">{job.readErrorCode || job.exportErrorCode || "None"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ) : null}

              <div className="space-y-4 rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="max-w-3xl">
                    <div className="font-medium">Companion overview sharing</div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      When two configured plate cameras clearly captured the same plate and direction at the same derived Overview time, a validated primary image may fill one terminal companion failure. Matches require exact plate identity, different plate cameras, matching Blue Iris direction, profile timing agreement, and no competing read. Ambiguous, multi-vehicle, nighttime, configuration, and direction failures remain untouched.
                    </p>
                  </div>
                  <Badge variant={overviewSetup?.status?.pairSharing?.mode === "active" ? "default" : "secondary"}>
                    {overviewSetup?.status?.pairSharing?.mode === "active"
                      ? "Active"
                      : overviewSetup?.status?.pairSharing?.mode === "shadow"
                        ? "Shadow only"
                        : "Off"}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-5">
                  <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.pairSharing?.proposed || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">proposed</div></div>
                  <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.pairSharing?.processing || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">processing</div></div>
                  <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.pairSharing?.applied || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">shared</div></div>
                  <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.pairSharing?.rejected || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">ambiguous rejected</div></div>
                  <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.status?.pairSharing?.failed || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">copy failures</div></div>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[15rem] space-y-2">
                    <Label>Sharing mode</Label>
                    <Select value={pairSharingMode} onValueChange={setPairSharingMode}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Off</SelectItem>
                        <SelectItem value="shadow">Shadow proposals only</SelectItem>
                        <SelectItem value="active">Active guarded sharing</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant={pairSharingMode === "active" ? "default" : "secondary"}
                    disabled={Boolean(busy) || pairSharingMode === overviewSetup?.status?.pairSharing?.mode}
                    onClick={savePairSharingMode}
                  >
                    {busy === "overview-pair-sharing" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save sharing mode
                  </Button>
                </div>
                {overviewSetup?.status?.pairSharing?.recent?.length ? (
                  <details className="rounded-md border">
                    <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Recent pair decisions</summary>
                    <div className="overflow-x-auto border-t">
                      <table className="w-full min-w-[760px] text-left text-xs">
                        <thead className="border-b text-muted-foreground">
                          <tr><th className="px-3 py-2">Plate</th><th className="px-3 py-2">Source to target</th><th className="px-3 py-2">Direction</th><th className="px-3 py-2">Anchor delta</th><th className="px-3 py-2">Decision</th></tr>
                        </thead>
                        <tbody>
                          {overviewSetup.status.pairSharing.recent.map((item) => (
                            <tr key={item.id} className="border-b last:border-0">
                              <td className="px-3 py-2 font-mono">{item.plateNumber || "Unknown"}</td>
                              <td className="px-3 py-2">{item.sourceReadId ? `#${item.sourceReadId} ${item.sourceCameraName}` : "No unique source"} to #{item.targetReadId} {item.targetCameraName}</td>
                              <td className="px-3 py-2">{item.directionLabel || "Unknown"}</td>
                              <td className="px-3 py-2 font-mono">{item.anchorDeltaMs == null ? "n/a" : `${item.anchorDeltaMs} ms`}</td>
                              <td className="px-3 py-2">{item.status}: {item.errorCode || item.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ) : null}
              </div>

              <div className="space-y-4 rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="max-w-3xl">
                    <div className="font-medium">Guarded Entry route fallback</div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      If the primary overview and companion sharing both fail, Entry LPR evidence must prove route timing and plate identity. Two-camera evidence is preferred. One Entry read may qualify only when it has authoritative matching Blue Iris direction, a ready daytime Entry Overview (Cam143) view, an exact plate or one confusion-normalized OCR edit on a plate of at least five characters, and no competing plausible event. Conflicting direction, short fuzzy plates, nighttime evidence, and ambiguity fail closed. Cam143 supplies the image but never establishes plate identity, and a source-only trigger never creates a target read.
                    </p>
                  </div>
                  <Badge variant={overviewSetup?.entryFallback?.mode === "active" && overviewSetup?.entryFallback?.overviewPayloadMode === "active" ? "default" : "secondary"}>
                    {overviewSetup?.entryFallback?.mode === "active" && overviewSetup?.entryFallback?.overviewPayloadMode === "active"
                      ? "Active"
                      : overviewSetup?.entryFallback?.mode === "shadow" || overviewSetup?.entryFallback?.overviewPayloadMode === "shadow"
                        ? "Shadow only"
                        : "Off"}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-5">
                  <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.entryFallback?.proposed || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">proposed</div></div>
                  <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.entryFallback?.processing || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">processing</div></div>
                  <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.entryFallback?.applied || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">filled</div></div>
                  <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.entryFallback?.rejected || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">rejected</div></div>
                  <div className="rounded-md border p-2"><div className="font-semibold">{Number(overviewSetup?.entryFallback?.failed || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">copy failures</div></div>
                </div>
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-[15rem_15rem_18rem_auto] lg:items-end">
                  <div className="space-y-2">
                    <Label>Fallback mode</Label>
                    <Select value={entryFallbackMode} onValueChange={setEntryFallbackMode}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Off</SelectItem>
                        <SelectItem value="shadow">Shadow proposals only</SelectItem>
                        <SelectItem value="active">Active guarded fallback</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Cam143 payload mode</Label>
                    <Select value={entryFallbackPayloadMode} onValueChange={setEntryFallbackPayloadMode}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Off</SelectItem>
                        <SelectItem value="shadow">Shadow validation only</SelectItem>
                        <SelectItem value="active">Active validated payload</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Keep Shadow until proposed Entry Overview payloads have been reviewed.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="entry-fallback-start">Observe reads after</Label>
                    <Input id="entry-fallback-start" type="datetime-local" value={entryFallbackStart} onChange={(event) => setEntryFallbackStart(event.target.value)} />
                  </div>
                  <Button
                    type="button"
                    variant={entryFallbackMode === "active" && entryFallbackPayloadMode === "active" ? "default" : "secondary"}
                    disabled={Boolean(busy) || (
                      entryFallbackMode === overviewSetup?.entryFallback?.mode
                      && entryFallbackPayloadMode === (overviewSetup?.entryFallback?.overviewPayloadMode || "shadow")
                      && entryFallbackStart === localDateTimeInput(overviewSetup?.entryFallback?.observationStartedAt)
                    )}
                    onClick={saveEntryFallbackMode}
                  >
                    {busy === "entry-fallback-mode" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save guarded fallback
                  </Button>
                </div>

                <div className="grid gap-4 rounded-md border p-3 md:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-2 lg:col-span-2">
                    <Label htmlFor="entry-route-name">Route name</Label>
                    <Input id="entry-route-name" value={entryRouteDraft.routeName} onChange={(event) => setEntryRouteDraft({ ...entryRouteDraft, routeName: event.target.value })} placeholder="Example: Street eastbound entering driveway" />
                  </div>
                  <div className="space-y-2">
                    <Label>Existing Street target read</Label>
                    <Select
                      value={entryRouteDraft.targetCameraName}
                      onValueChange={(targetCameraName) => {
                        const selected = overviewSetup?.plateCameras?.find((item) => item.cameraName === targetCameraName);
                        setEntryRouteDraft({
                          ...entryRouteDraft,
                          targetCameraName,
                          targetDirectionLabel: selected?.directions?.[0] || "",
                        });
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Street camera" /></SelectTrigger>
                      <SelectContent>{(overviewSetup?.plateCameras || []).map((item) => <SelectItem key={item.cameraName} value={item.cameraName}>{item.cameraName}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Street direction</Label>
                    <Select value={entryRouteDraft.targetDirectionLabel} onValueChange={(targetDirectionLabel) => setEntryRouteDraft({ ...entryRouteDraft, targetDirectionLabel })}>
                      <SelectTrigger><SelectValue placeholder="Direction" /></SelectTrigger>
                      <SelectContent>
                        {(overviewSetup?.plateCameras?.find((item) => item.cameraName === entryRouteDraft.targetCameraName)?.directions || []).map((direction) => <SelectItem key={direction} value={direction}>{direction}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {[0, 1].map((index) => (
                    <div key={index} className="space-y-2">
                      <Label>Corroborating source {index + 1}</Label>
                      <Select
                        value={entryRouteDraft.sourceCameraNames[index] || ""}
                        onValueChange={(cameraName) => {
                          const sourceCameraNames = [...entryRouteDraft.sourceCameraNames];
                          sourceCameraNames[index] = cameraName;
                          const selected = overviewSetup?.plateCameras?.find((item) => item.cameraName === cameraName);
                          setEntryRouteDraft({
                            ...entryRouteDraft,
                            sourceCameraNames,
                            sourceDirectionLabel: entryRouteDraft.sourceDirectionLabel || selected?.directions?.[0] || "",
                          });
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder="Entry camera" /></SelectTrigger>
                        <SelectContent>{(overviewSetup?.plateCameras || []).map((item) => <SelectItem key={item.cameraName} value={item.cameraName}>{item.cameraName}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  ))}
                  <div className="space-y-2">
                    <Label htmlFor="entry-route-direction">Entry direction</Label>
                    <Input id="entry-route-direction" value={entryRouteDraft.sourceDirectionLabel} onChange={(event) => setEntryRouteDraft({ ...entryRouteDraft, sourceDirectionLabel: event.target.value })} placeholder="Entering or Exiting" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="entry-route-delta">Expected delta (ms)</Label>
                    <Input id="entry-route-delta" type="number" min="-30000" max="30000" value={entryRouteDraft.expectedDeltaMs} onChange={(event) => setEntryRouteDraft({ ...entryRouteDraft, expectedDeltaMs: Number(event.target.value) })} />
                    <p className="text-xs text-muted-foreground">Entry event minus Street read. Negative means Entry occurred first.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="entry-route-tolerance">Route tolerance (ms)</Label>
                    <Input id="entry-route-tolerance" type="number" min="250" max="15000" step="50" value={entryRouteDraft.toleranceMs} onChange={(event) => setEntryRouteDraft({ ...entryRouteDraft, toleranceMs: Number(event.target.value) })} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="entry-route-event-window">Entry pair window (ms)</Label>
                    <Input id="entry-route-event-window" type="number" min="250" max="5000" step="50" value={entryRouteDraft.eventWindowMs} onChange={(event) => setEntryRouteDraft({ ...entryRouteDraft, eventWindowMs: Number(event.target.value) })} />
                  </div>
                  <div className="flex items-center gap-3 pt-6">
                    <Switch checked={entryRouteDraft.enabled} onCheckedChange={(enabled) => setEntryRouteDraft({ ...entryRouteDraft, enabled })} />
                    <Label>Route enabled</Label>
                  </div>
                  <div className="lg:col-span-4">
                    <Button type="button" onClick={saveEntryRoute} disabled={Boolean(busy)}>
                      {busy === "entry-route" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                      Save Entry route
                    </Button>
                  </div>
                </div>

                {(overviewSetup?.entryRouteProfiles || []).length ? (
                  <div className="space-y-2">
                    {overviewSetup.entryRouteProfiles.map((route) => (
                      <div key={route.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
                        <div>
                          <div className="font-medium">{route.routeName} {!route.enabled ? <Badge variant="secondary">Disabled</Badge> : null}</div>
                          <div className="text-xs text-muted-foreground">
                            {route.targetCameraName} {route.targetDirectionLabel} to {route.sourceCameraNames.join(" + ")} {route.sourceDirectionLabel}; {route.expectedDeltaMs} ms ± {route.toleranceMs} ms
                          </div>
                        </div>
                        <Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => removeEntryRoute(route.id)}>
                          {busy === `entry-route-delete:${route.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : null}

                {overviewSetup?.entryFallback?.recent?.length ? (
                  <details className="rounded-md border">
                    <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Recent Entry fallback decisions</summary>
                    <div className="overflow-x-auto border-t">
                      <table className="w-full min-w-[760px] text-left text-xs">
                        <thead className="border-b text-muted-foreground">
                          <tr><th className="px-3 py-2">Plate</th><th className="px-3 py-2">Route</th><th className="px-3 py-2">Identity reads</th><th className="px-3 py-2">Cam143 payload</th><th className="px-3 py-2">Timing</th><th className="px-3 py-2">Decision</th></tr>
                        </thead>
                        <tbody>
                          {overviewSetup.entryFallback.recent.map((item) => (
                            <tr key={item.id} className="border-b last:border-0">
                              <td className="px-3 py-2 font-mono">{item.targetPlate || "Unknown"}</td>
                              <td className="px-3 py-2">{item.routeName}</td>
                              <td className="px-3 py-2">
                                {[item.sourceReadId, ...(item.corroboratingReadIds || [])]
                                  .filter(Boolean)
                                  .map((readId) => `#${readId}`)
                                  .join(" + ") || "No corroborated pair"}
                                {` to Street #${item.targetReadId}`}
                              </td>
                              <td className="px-3 py-2">
                                {item.payloadReadId
                                  ? `Entry Overview from #${item.payloadReadId}${item.payloadImageWidth && item.payloadImageHeight ? ` (${item.payloadImageWidth}x${item.payloadImageHeight})` : ""}`
                                  : "Waiting for validated Entry Overview"}
                              </td>
                              <td className="px-3 py-2 font-mono">{item.actualDeltaMs == null ? "n/a" : `${item.actualDeltaMs} ms`}</td>
                              <td className="px-3 py-2">{item.status}: {item.errorCode || item.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ) : null}
              </div>

              <div className="rounded-lg border p-4">
                <div className="mb-4 max-w-4xl">
                  <div className="font-medium">Direct plate-camera overview mappings</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    These mappings create the normal Vehicle View for every eligible plate read. For Entry LPR 1 and Entry LPR 2, select Entry overview so each read retrieves its own image from Entry Overview (Cam143). This is separate from the guarded route fallback above, which starts with an existing Street LPR read, prefers two corroborating Entry reads, and permits one only under strict direction, timing, identity, payload, and ambiguity safeguards.
                  </p>
                </div>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-2">
                    <Label>Overview use</Label>
                    <Select
                      value={overviewDraft.overviewContext}
                      onValueChange={(overviewContext) => {
                        if (overviewContext !== "entry") {
                          setOverviewDraft({ ...overviewDraft, overviewContext });
                          return;
                        }
                        const entryPlateCamera = (overviewSetup?.plateCameras || [])
                          .find((item) => ENTRY_OVERVIEW_HISTORY_CAMERAS.includes(item.cameraName));
                        const plateCameraName = ENTRY_OVERVIEW_HISTORY_CAMERAS.includes(overviewDraft.plateCameraName)
                          ? overviewDraft.plateCameraName
                          : entryPlateCamera?.cameraName || overviewDraft.plateCameraName;
                        const selected = overviewSetup?.plateCameras?.find((item) => item.cameraName === plateCameraName);
                        setOverviewDraft({
                          ...overviewDraft,
                          overviewContext,
                          sourceCameraName: ENTRY_OVERVIEW_SOURCE_CAMERA,
                          sourceCameraShortName: ENTRY_OVERVIEW_SOURCE_SHORT_NAME,
                          sourceRole: "primary",
                          plateCameraName,
                          directionLabel: selected?.directions?.[0] || overviewDraft.directionLabel,
                        });
                      }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="street">Street overview</SelectItem>
                        <SelectItem value="entry">Entry overview</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2 lg:col-span-2">
                    <Label htmlFor="overview-source-camera">Overview source camera</Label>
                    <Input
                      id="overview-source-camera"
                      list="overview-source-cameras"
                      value={overviewDraft.sourceCameraName}
                      onChange={(event) => {
                        const sourceCameraName = event.target.value;
                        setOverviewDraft({
                          ...overviewDraft,
                          sourceCameraName,
                          sourceCameraShortName: overviewDraft.overviewContext === "entry" && sourceCameraName.trim().toLowerCase() === ENTRY_OVERVIEW_SOURCE_CAMERA.toLowerCase()
                            ? ENTRY_OVERVIEW_SOURCE_SHORT_NAME
                            : overviewDraft.sourceCameraShortName,
                        });
                      }}
                      placeholder="Example: Street Overview or Entry Overview"
                    />
                    <datalist id="overview-source-cameras">
                      {[...new Set([...(overviewSetup?.status?.observedSources || []), ENTRY_OVERVIEW_SOURCE_CAMERA])].map((source) => <option key={source} value={source} />)}
                    </datalist>
                    <p className="text-xs text-muted-foreground">This is an editable field, not a restricted list. Use the Blue Iris display name; Entry Overview is bound separately to Cam143.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="overview-source-camera-short-name">Blue Iris short name</Label>
                    <Input
                      id="overview-source-camera-short-name"
                      value={overviewDraft.sourceCameraShortName || ""}
                      onChange={(event) => setOverviewDraft({ ...overviewDraft, sourceCameraShortName: event.target.value })}
                      placeholder={overviewDraft.overviewContext === "entry" ? "Required, for example Cam143" : "Optional, for example Cam149"}
                    />
                    <p className="text-xs text-muted-foreground">Required for Entry so ALPR verifies the exact Blue Iris camera before exporting.</p>
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
                        {(overviewSetup?.plateCameras || [])
                          .filter((item) => overviewDraft.overviewContext !== "entry" || ENTRY_OVERVIEW_HISTORY_CAMERAS.includes(item.cameraName))
                          .map((item) => <SelectItem key={item.cameraName} value={item.cameraName}>{item.cameraName}</SelectItem>)}
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
                    <Select
                      value={overviewDraft.sourceRole}
                      disabled={overviewDraft.overviewContext === "entry"}
                      onValueChange={(sourceRole) => setOverviewDraft({ ...overviewDraft, sourceRole })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="primary">Primary overview</SelectItem>
                        {overviewDraft.overviewContext !== "entry" ? <SelectItem value="fallback">Legacy overview fallback profile</SelectItem> : null}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {overviewDraft.overviewContext === "entry"
                        ? "Entry LPR reads always use Cam143 as their direct Primary overview."
                        : "The paired driveway route is configured separately above."}
                    </p>
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
                <Button className="mt-4" onClick={saveOverviewProfile} disabled={Boolean(busy) || !overviewDraft.sourceCameraName || !overviewDraft.plateCameraName || !overviewDraft.directionLabel || (overviewDraft.overviewContext === "entry" && !overviewDraft.sourceCameraShortName?.trim()) || overviewDraft.sourceCameraName.trim().toLowerCase() === overviewDraft.plateCameraName.trim().toLowerCase()}>
                  {busy === "overview-profile" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save overview association
                </Button>
              </div>

              {overviewSetup?.profiles?.length ? (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[1050px] text-left text-sm">
                    <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                      <tr><th className="px-3 py-2">Use</th><th className="px-3 py-2">Source</th><th className="px-3 py-2">Plate camera</th><th className="px-3 py-2">Direction</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Expected / tolerance</th><th className="px-3 py-2">State</th><th className="px-3 py-2">Action</th></tr>
                    </thead>
                    <tbody>
                      {overviewSetup.profiles.map((item) => (
                        <tr key={item.id} className="border-b last:border-0">
                          <td className="px-3 py-2 capitalize">{item.overviewContext || "street"}</td>
                          <td className="px-3 py-2">{item.sourceCameraName}{item.sourceCameraShortName ? <span className="ml-1 text-xs text-muted-foreground">({item.sourceCameraShortName})</span> : null}</td>
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
                <div className="font-medium">No overview-camera alert action required</div>
                <p className="mt-1 text-xs text-muted-foreground">ALPR retrieves the configured Street Overview or Entry Overview timeline directly after a daytime plate read. Do not add a separate Blue Iris motion web request for this feature.</p>
              </div>
            </CardContent>
          </Card>

          <Card className="mt-6">
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2"><History className="h-5 w-5" /> Entry Overview history</CardTitle>
                  <CardDescription className="mt-1 max-w-3xl">
                    Preview a frozen daytime range, then queue small batches that retrieve Entry Overview for existing Entry LPR reads. Live Vehicle Views always remain first in line.
                  </CardDescription>
                </div>
                <Badge variant={entryHistoryProfilesConfigured ? "default" : "secondary"}>
                  {entryHistoryProfilesConfigured ? "Anchors ready" : "Set both anchors"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-3 rounded-lg border p-4 text-sm md:grid-cols-3">
                <div>
                  <div className="text-xs text-muted-foreground">Fixed overview source</div>
                  <div className="font-medium">Entry Overview <span className="text-muted-foreground">(Cam143)</span></div>
                </div>
                <div className="md:col-span-2">
                  <div className="text-xs text-muted-foreground">Existing plate reads</div>
                  <div className="font-medium">Entry LPR 1 and Entry LPR 2</div>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                {ENTRY_OVERVIEW_HISTORY_CAMERAS.map((plateCameraName) => (
                  <div key={plateCameraName} className="space-y-2">
                    <Label htmlFor={`entry-history-delta-${plateCameraName.replaceAll(" ", "-").toLowerCase()}`}>
                      {plateCameraName} expected delta (ms)
                    </Label>
                    <Input
                      id={`entry-history-delta-${plateCameraName.replaceAll(" ", "-").toLowerCase()}`}
                      type="number"
                      min="-30000"
                      max="30000"
                      step="50"
                      value={entryHistoryDeltas[plateCameraName] ?? ""}
                      onChange={(event) => setEntryHistoryDeltas((current) => ({
                        ...current,
                        [plateCameraName]: event.target.value,
                      }))}
                      placeholder="Overview time minus plate-read time"
                    />
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={Boolean(busy) || !entryHistoryDeltasValid || !entryHistoryProfilesDirty}
                  onClick={saveEntryHistoryProfiles}
                >
                  {busy === "entry-history-profiles" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save Entry anchors
                </Button>
                <p className="text-xs text-muted-foreground">
                  Delta means Entry Overview time minus plate-read time. Each anchor uses a fixed ±3,000 ms tolerance.
                </p>
              </div>

              <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="entry-history-start">History start</Label>
                  <Input
                    id="entry-history-start"
                    type="datetime-local"
                    value={entryHistoryStart}
                    onChange={(event) => {
                      setEntryHistoryStart(event.target.value);
                      setEntryHistoryRun(null);
                      setEntryHistoryMessage("");
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="entry-history-end">History end</Label>
                  <Input
                    id="entry-history-end"
                    type="datetime-local"
                    value={entryHistoryEnd}
                    onChange={(event) => {
                      setEntryHistoryEnd(event.target.value);
                      setEntryHistoryRun(null);
                      setEntryHistoryMessage("");
                    }}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-3 md:col-span-2">
                  <Button
                    type="button"
                    disabled={Boolean(busy)
                      || !frameQueue?.configured
                      || !entryHistoryProfilesConfigured
                      || entryHistoryProfilesDirty
                      || !entryHistoryRangeValid}
                    onClick={previewEntryHistory}
                  >
                    {busy === "entry-history-preview" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}
                    Preview frozen range
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Times are entered in this browser&apos;s local timezone and sent as explicit instants. The end is exclusive and both boundaries are frozen by the preview.
                  </p>
                </div>
              </div>

              {entryHistoryRun ? (
                <div className="space-y-4 rounded-lg border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">Run #{entryHistoryRun.id}</div>
                      <div className="text-xs text-muted-foreground">
                        Frozen {entryHistoryRun.startAt ? new Date(entryHistoryRun.startAt).toLocaleString() : "start unavailable"}
                        {" through "}
                        {entryHistoryRun.endAt ? new Date(entryHistoryRun.endAt).toLocaleString() : "end unavailable"} (exclusive)
                      </div>
                    </div>
                    <Badge variant={entryHistoryRun.status === "completed" ? "default" : "secondary"} className="capitalize">
                      {entryHistoryRun.status}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4 lg:grid-cols-8">
                    <div className="rounded-md border p-2"><div className="font-semibold">{Number(entryHistoryCounts.total || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">in scope</div></div>
                    <div className="rounded-md border p-2"><div className="font-semibold">{Number(entryHistoryCounts.previewed || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">still previewed</div></div>
                    <div className="rounded-md border p-2"><div className="font-semibold">{entryHistoryRemaining.toLocaleString()}</div><div className="text-xs text-muted-foreground">queueable next</div></div>
                    <div className="rounded-md border p-2"><div className="font-semibold">{Number(entryHistoryCounts.missingCandidates || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">missing views</div></div>
                    <div className="rounded-md border p-2"><div className="font-semibold">{Number(entryHistoryCounts.upgradeCandidates || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">upgrade candidates</div></div>
                    <div className="rounded-md border p-2"><div className="font-semibold">{Number(entryHistoryCounts.preserved || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">preserved</div></div>
                    <div className="rounded-md border p-2"><div className="font-semibold">{Number(entryHistoryCounts.nighttime || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">nighttime skipped</div></div>
                    <div className="rounded-md border p-2"><div className="font-semibold">{Number(entryHistoryCounts.liveBusy || 0).toLocaleString()}</div><div className="text-xs text-muted-foreground">live work protected</div></div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span>{entryHistoryFinished.toLocaleString()} terminal of {entryHistoryConfirmable.toLocaleString()} eligible</span>
                      <span>{entryHistoryProgress}%</span>
                    </div>
                    <Progress value={entryHistoryProgress} />
                    <div className="grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-6">
                      <div><span className="font-medium">{Number(entryHistoryCounts.queued || 0).toLocaleString()}</span> queued</div>
                      <div><span className="font-medium">{Number(entryHistoryCounts.processing || 0).toLocaleString()}</span> processing</div>
                      <div><span className="font-medium">{Number(entryHistoryCounts.ready || 0).toLocaleString()}</span> ready</div>
                      <div><span className="font-medium">{Number(entryHistoryCounts.failed || 0).toLocaleString()}</span> failed</div>
                      <div><span className="font-medium">{Number(entryHistoryCounts.unavailable || 0).toLocaleString()}</span> unavailable</div>
                      <div><span className="font-medium">{(Number(entryHistoryCounts.superseded || 0) + Number(entryHistoryCounts.cancelled || 0)).toLocaleString()}</span> skipped</div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-[9rem] space-y-2">
                      <Label>Next batch</Label>
                      <Select value={entryHistoryBatchSize} onValueChange={setEntryHistoryBatchSize}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1">1 read</SelectItem>
                          <SelectItem value="5">5 reads</SelectItem>
                          <SelectItem value="25">25 reads</SelectItem>
                          <SelectItem value="250">250 reads</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      type="button"
                      disabled={Boolean(busy)
                        || !entryHistoryRun.previewFingerprint
                        || entryHistoryRemaining < 1
                        || entryHistoryBatchActive
                        || ["paused", "cancelled", "completed"].includes(entryHistoryRun.status)}
                      onClick={confirmEntryHistory}
                    >
                      {busy === "entry-history-confirm" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                      Queue next batch ({Math.min(Number(entryHistoryBatchSize), entryHistoryRemaining)})
                    </Button>
                    {["running", "paused"].includes(entryHistoryRun.status) ? (
                      <Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={toggleEntryHistoryPaused}>
                        {busy === "entry-history-pause" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : entryHistoryRun.status === "paused" ? <Play className="mr-2 h-4 w-4" /> : <Pause className="mr-2 h-4 w-4" />}
                        {entryHistoryRun.status === "paused" ? "Resume history" : "Pause history"}
                      </Button>
                    ) : null}
                    {["previewed", "running", "paused"].includes(entryHistoryRun.status) ? (
                      <Button type="button" variant="destructive" disabled={Boolean(busy)} onClick={cancelEntryHistory}>
                        {busy === "entry-history-cancel" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
                        Cancel remaining
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Wait for queued and processing to return to zero, then queue the next bounded batch. Repeat until “queueable next” reaches zero. A batch does not displace a live read, and successful existing images are never replaced before a new image is validated.
                  </p>
                </div>
              ) : (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  Save both timing anchors and preview an exact range before any historical read can be queued.
                </p>
              )}

              {entryHistoryRetryCandidates.length ? (
                <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
                  <div>
                    <div className="font-medium">Failed imports eligible for retry</div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Only terminal transient import or processing failures appear here. Each failed import receives one manual retry cycle, reuses its existing Blue Iris export identity, and never replaces an existing image before a new one is validated.
                    </p>
                  </div>
                  <div className="space-y-2">
                    {entryHistoryRetryCandidates.map((candidate) => (
                      <div key={candidate.jobId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm">
                        <div>
                          <div className="font-medium">
                            {candidate.readTimestamp ? new Date(candidate.readTimestamp).toLocaleString() : "Timestamp unavailable"}
                            {candidate.plateNumber ? ` · ${candidate.plateNumber}` : ""}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {candidate.plateCameraName} · {candidate.errorCode || "Import failed"} · {candidate.attemptCount} attempts
                            {candidate.preservesExistingImage ? " · current image preserved" : ""}
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={Boolean(busy) || entryHistoryBatchActive}
                          onClick={() => retryEntryHistoryImport(candidate.jobId)}
                        >
                          {busy === `entry-history-retry-${candidate.jobId}`
                            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            : <RotateCcw className="mr-2 h-4 w-4" />}
                          Retry failed import
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {entryHistoryMessage ? (
                <p className="rounded-md border p-3 text-sm" role="status">{entryHistoryMessage}</p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Images className="h-5 w-5" /> Blue Iris vehicle views</CardTitle>
            <CardDescription>
              New daytime reads export one temporary configured overview-camera timeline segment, analyze 61 local frames at 100 ms intervals, and retain the exact selected full-resolution frame. ALPR removes its local workspace; Blue Iris removes Clipboard exports according to your configured retention. The older plate-camera selector remains only for historical jobs and deliberate manual recovery.
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
                <Label>Non-Entry camera for legacy vehicle-view history</Label>
                <Select value={genericFrameHistoryCameraAllowed ? cameraName : ""} onValueChange={selectCamera}>
                  <SelectTrigger><SelectValue placeholder="Select a camera" /></SelectTrigger>
                  <SelectContent>
                    {genericFrameHistoryProfiles.map((item) => <SelectItem key={item.cameraName} value={item.cameraName}>{item.cameraName}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Entry LPR 1 and Entry LPR 2 are intentionally excluded. Their history must use the previewed Entry Overview batches above.</p>
              </div>
              <details className="rounded-md border sm:col-span-2">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Optional date range</summary>
                <div className="grid gap-3 border-t p-3 sm:grid-cols-2">
                  <div className="space-y-2"><Label htmlFor="frame-history-start">History start</Label><Input id="frame-history-start" type="date" value={frameStartDate} onChange={(event) => setFrameStartDate(event.target.value)} /></div>
                  <div className="space-y-2"><Label htmlFor="frame-history-end">History end</Label><Input id="frame-history-end" type="date" value={frameEndDate} onChange={(event) => setFrameEndDate(event.target.value)} /></div>
                </div>
              </details>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <Button variant="outline" disabled={Boolean(busy) || !genericFrameHistoryCameraAllowed || !frameQueue?.configured} onClick={() => queueFrameHistory(false)}>{busy === "frame-history-camera" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Queue {genericFrameHistoryCameraAllowed ? cameraName : "selected camera"} history</Button>
                <Button variant="outline" disabled={Boolean(busy) || !frameQueue?.configured || entryHistoryProfilesConfigured} onClick={() => queueFrameHistory(true)}>{busy === "frame-history-all" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Queue all camera history</Button>
                <Button variant="outline" disabled={Boolean(busy) || !frameQueue?.configured || entryHistoryProfilesConfigured} onClick={() => queueFrameHistory(true, true)}>{busy === "frame-history-reevaluate" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Reevaluate existing views</Button>
                <Button variant="secondary" disabled={Boolean(busy) || !frameQueue?.configured} onClick={toggleFrameHistory}>{frameQueue?.historicalPaused ? <Play className="mr-2 h-4 w-4" /> : <Pause className="mr-2 h-4 w-4" />}{frameQueue?.historicalPaused ? "Resume history" : "Pause history"}</Button>
                <Button variant="destructive" disabled={Boolean(busy) || !genericFrameHistoryCameraAllowed || !frameQueue?.historicalOutstanding} onClick={() => setCancelFrameHistoryOpen(true)}><XCircle className="mr-2 h-4 w-4" />Cancel pending {genericFrameHistoryCameraAllowed ? cameraName : "camera"} history</Button>
                <Button variant="secondary" disabled={Boolean(busy) || !frameQueue?.configured} onClick={runFrameBatch}>{busy === "frame-batch" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}Run one frame now</Button>
                <div className="flex min-w-[18rem] flex-col gap-1">
                  <Label htmlFor="overview-recovery-start">Incomplete overview recovery start</Label>
                  <Input id="overview-recovery-start" type="datetime-local" value={overviewRecoveryStart} onChange={(event) => { setOverviewRecoveryStart(event.target.value); setOverviewRecoveryPreview(null); }} />
                </div>
                <Button variant="outline" disabled={Boolean(busy) || !frameQueue?.configured || !overviewRecoveryStart} onClick={previewIncompleteOverview}>{busy === "overview-recovery-preview" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}Preview incomplete jobs</Button>
                <Button variant="outline" disabled={Boolean(busy) || !frameQueue?.configured || !overviewRecoveryPreview || overviewRecoveryPreview.eligible < 1} onClick={recoverIncompleteOverview}>{busy === "overview-recovery" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <History className="mr-2 h-4 w-4" />}Queue {overviewRecoveryPreview ? Number(overviewRecoveryPreview.eligible || 0).toLocaleString() : "previewed"} incomplete jobs</Button>
              </div>
              <div className="space-y-3 rounded-md border p-3 sm:col-span-2">
                <div>
                  <div className="font-medium">Repair missed Blue Iris 6 composite triggers</div>
                  <p className="text-xs text-muted-foreground">Use this only for reads created before composite &amp;TYPE compatibility was installed. Preview joins each read to its one retained accepted ingress receipt, requires the unchanged camera mapping and exact never-started overview state, then queues at most 250 reads. Re-running is safe; completed or changed reads are excluded.</p>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex min-w-[18rem] flex-col gap-1">
                    <Label htmlFor="trigger-recovery-start">Affected reads start</Label>
                    <Input id="trigger-recovery-start" type="datetime-local" value={triggerRecoveryStart} onChange={(event) => { setTriggerRecoveryStart(event.target.value); setTriggerRecoveryPreview(null); }} />
                  </div>
                  <Button variant="outline" disabled={Boolean(busy) || !frameQueue?.configured || !triggerRecoveryStart} onClick={previewCompositeTriggerRecovery}>{busy === "trigger-recovery-preview" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}Preview trigger repair</Button>
                  <Button variant="outline" disabled={Boolean(busy) || !frameQueue?.configured || !triggerRecoveryPreview?.readIds?.length} onClick={recoverCompositeTriggers}>{busy === "trigger-recovery" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <History className="mr-2 h-4 w-4" />}Repair and queue {triggerRecoveryPreview ? Number(triggerRecoveryPreview.eligible || 0).toLocaleString() : "previewed"}</Button>
                </div>
              </div>
            </div>
            {frameMessage && <p className="rounded-md border p-3 text-sm">{frameMessage}</p>}
          </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="processing" className="mt-0">
          <VehicleImageAssetCatalogPanel initialOverview={initialVehicleImageCatalog} />
          <VehicleEventShadowPanel initialOverview={initialVehicleEventShadow} />
          <VehicleImageCropPanel initialOverview={initialVehicleImageCrops} />
          <VehicleAssetEmbeddingPanel initialOverview={initialVehicleAssetEmbeddings} />
          <Card className="mt-6">
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
