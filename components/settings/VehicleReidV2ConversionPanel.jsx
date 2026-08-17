"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Database,
  Fingerprint,
  GitCompareArrows,
  Loader2,
  Pause,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import {
  acceptVehicleReidV2ConversionPreview,
  cancelVehicleReidV2ConversionPreview,
  getVehicleReidV2ConversionPreviewOverview,
  materializeVehicleReidV2ConversionPreview,
  processVehicleReidV2ConversionPreviewBatch,
  retryVehicleReidV2ConversionPreviewJob,
  setVehicleReidV2ConversionPreviewPaused,
  startVehicleReidV2ConversionPreview,
  transitionVehicleReidAuthorityMode,
  verifyVehicleReidV2ConversionPreview,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const BATCH_SIZES = Object.freeze([1, 5, 25, 250]);
const TERMINAL_STATUSES = new Set(["completed", "stale", "cancelled", "failed", "rolled_back"]);
const ACTIVE_STATUSES = new Set(["starting", "previewing", "verifying", "cancelling"]);

const STATUS_LABELS = Object.freeze({
  not_started: "Not started",
  starting: "Starting",
  previewing: "Building preview",
  ready: "Preview ready to verify",
  accepted: "Accepted for materialization",
  running: "Materializing authority",
  processing: "Processing",
  paused: "Paused",
  verifying: "Verifying fingerprints",
  verified: "Verified",
  completed: "Materialization complete",
  stale: "Evidence changed",
  cancelled: "Cancelled",
  failed: "Needs attention",
  rolled_back: "Rolled back",
});

function count(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function formatCount(value) {
  return count(value).toLocaleString();
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatDateTime(value) {
  if (!value) return "Not verified";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}

function overviewFromResult(result) {
  const overview = result?.data?.overview || result?.data;
  if (!result?.success || !overview) {
    throw new Error(result?.error || "Unable to load the ReID v2 conversion preview.");
  }
  return overview;
}

function Metric({ label, value, detail = "" }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xl font-semibold tabular-nums">{formatCount(value)}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {detail ? <div className="mt-1 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function FingerprintValue({ label, value }) {
  return (
    <div className="space-y-1 rounded-md border p-3">
      <div className="text-xs font-medium">{label}</div>
      <code className="block break-all text-xs text-muted-foreground">{text(value) || "Not frozen"}</code>
    </div>
  );
}

function statusVariant(status) {
  if (["completed", "verified"].includes(status)) return "default";
  if (status === "failed") return "destructive";
  return "secondary";
}

export default function VehicleReidV2ConversionPanel({ initialOverview = null }) {
  const [overview, setOverview] = useState(initialOverview);
  const [batchSize, setBatchSize] = useState("5");
  const restoredBatchRun = useRef(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const run = overview?.latestRun || overview?.run || overview?.campaign || null;
  const projection = overview?.projection || run?.projection || overview?.latestProjection
    || run?.latestProjection || {};
  const metrics = {
    ...(run || {}),
    ...(overview?.previewMetrics || {}),
    ...(run?.previewMetrics || {}),
    ...(overview?.metrics || {}),
    ...(run?.metrics || {}),
    ...(projection?.metrics || {}),
  };
  const counts = run?.counts || overview?.counts || {};
  const status = text(run?.status || overview?.status) || "not_started";
  const runId = run?.id || run?.runId || run?.campaignId || null;
  const persistedBatchSize = Number(run?.batchSize ?? run?.batch_size);
  const previewFingerprint = text(
    run?.previewFingerprint || projection?.previewFingerprint || overview?.previewFingerprint
  );
  const identityEvidenceFingerprint = text(
    run?.identityEvidenceFingerprint
      || projection?.identityEvidenceFingerprint
      || overview?.identityEvidenceFingerprint
  );
  const algorithmVersion = text(
    run?.algorithmVersion || projection?.algorithmVersion || overview?.algorithmVersion
  );
  const sourceProfileCandidateFingerprint = text(
    run?.sourceProfileCandidateFingerprint || overview?.sourceProfileCandidateFingerprint
  );
  const lastRevalidationFingerprint = text(
    run?.lastRevalidationFingerprint || overview?.lastRevalidationFingerprint
  );
  const verification = overview?.verification || run?.verification || {};
  const lastRevalidationStatus = text(
    run?.lastRevalidationStatus || verification.status
  ) || "not_run";
  const lastRevalidatedAt = run?.lastRevalidatedAt || verification.verifiedAt || null;
  const controlMode = text(overview?.control?.mode) || "unknown";
  const authority = overview?.authority || {};
  const authorityHealth = overview?.authorityHealth || {};
  const authorityCounts = authorityHealth.counts || {};
  const liveJobs = authorityHealth.liveJobs || {};
  const liveWorker = overview?.liveWorker || authorityHealth.worker || {};
  const authoritativeProfiles = count(
    authorityCounts.profiles
      ?? authority.profileCount ?? authority.profiles ?? authority.authoritativeProfiles
  );
  const authoritativeMembers = count(
    authorityCounts.members
      ?? authority.memberCount ?? authority.members ?? authority.authoritativeMembers
  );
  const authoritativeAssignments = count(
    authorityCounts.assignments
      ?? authority.readAssignmentCount ?? authority.readAssignments ?? authority.assignments
      ?? authority.authoritativeReadAssignments
  );
  const retryCandidates = Array.isArray(overview?.retryCandidates)
    ? overview.retryCandidates.slice(0, 25)
    : Array.isArray(run?.retryCandidates) ? run.retryCandidates.slice(0, 25) : [];
  const conflicts = Array.isArray(projection?.conflicts)
    ? projection.conflicts.slice(0, 25)
    : Array.isArray(overview?.conflicts) ? overview.conflicts.slice(0, 25) : [];
  const sampleProfiles = Array.isArray(overview?.sampleProfiles)
    ? overview.sampleProfiles.slice(0, 25)
    : [];
  const dispositionCounts = metrics?.dispositionCounts && typeof metrics.dispositionCounts === "object"
    ? metrics.dispositionCounts
    : {};

  const totalReads = count(
    counts.totalReads ?? counts.total ?? metrics.totalReads ?? projection?.reads?.length
  );
  const processedReads = count(
    counts.processedReads ?? counts.processed ?? counts.completed
      ?? counts.ready
  );
  const processingReads = count(counts.processing);
  const retryableReads = count(counts.retryable);
  const failedReads = count(counts.failed);
  const claimableReads = count(counts.pending) + retryableReads;
  const remainingReads = count(
    counts.remainingReads ?? counts.remaining
      ?? (claimableReads + processingReads)
  );
  const progress = totalReads
    ? Math.min(100, Math.round(processedReads / totalReads * 100))
    : status === "completed" || status === "verified" ? 100 : 0;
  const polling = ACTIVE_STATUSES.has(status);
  const canStart = controlMode !== "v2_primary"
    && (!run || TERMINAL_STATUSES.has(status) || status === "verified");
  const canProcess = Boolean(runId)
    && status === "previewing"
    && processingReads === 0;
  const canPause = Boolean(runId) && ["previewing", "paused"].includes(status);
  const canCancel = Boolean(runId)
    && ["previewing", "ready", "paused"].includes(status)
    && processingReads === 0;
  const canVerify = Boolean(runId && previewFingerprint)
    && status === "ready"
    && processingReads === 0;
  const canAccept = canVerify && lastRevalidationStatus === "current";
  const canMaterialize = Boolean(runId && previewFingerprint) && status === "accepted";
  const canCutover = Boolean(runId) && status === "completed"
    && ["v2_shadow", "v1_rollback"].includes(controlMode);
  const canRollback = controlMode === "v2_primary";

  const projectionMetrics = useMemo(() => ([
    { label: "projected profiles", value: metrics.projectedProfiles },
    { label: "multi-member profiles", value: metrics.projectedMultiMemberProfiles },
    { label: "provisional singleton profiles", value: metrics.projectedSingletonProfiles },
    { label: "projected members", value: metrics.projectedMembers },
    { label: "assigned reads", value: metrics.assignedReads },
    { label: "unassigned reads", value: metrics.unassignedReads },
  ]), [
    metrics.assignedReads,
    metrics.projectedMembers,
    metrics.projectedMultiMemberProfiles,
    metrics.projectedProfiles,
    metrics.projectedSingletonProfiles,
    metrics.unassignedReads,
  ]);

  const assignmentMetrics = useMemo(() => ([
    { label: "canonical-image assignments", value: metrics.canonicalImageAssignments },
    { label: "shared-asset assignments", value: metrics.sharedAssetAssignments },
    { label: "exact-plate-only assignments", value: metrics.exactPlateOnlyAssignments },
    { label: "historical exact-plate assignments", value: metrics.historicalExactPlateAssignments },
    { label: "nighttime exact-plate assignments", value: metrics.nighttimeExactPlateAssignments },
    { label: "conflicted components", value: metrics.conflictedComponents },
    { label: "conflicted reads", value: metrics.conflictedReads },
    { label: "stale-evidence reads", value: metrics.staleEvidenceReads },
  ]), [
    metrics.canonicalImageAssignments,
    metrics.conflictedComponents,
    metrics.conflictedReads,
    metrics.exactPlateOnlyAssignments,
    metrics.historicalExactPlateAssignments,
    metrics.nighttimeExactPlateAssignments,
    metrics.sharedAssetAssignments,
    metrics.staleEvidenceReads,
  ]);

  const comparisonMetrics = useMemo(() => ([
    { label: "assigned in v1", value: metrics.v1AssignedReads },
    { label: "assigned in both", value: metrics.bothAssignedReads },
    { label: "v1 only", value: metrics.v1OnlyReads },
    { label: "projected v2 only", value: metrics.v2OnlyReads },
    { label: "assigned in neither", value: metrics.neitherAssignedReads },
    { label: "exact partition matches", value: metrics.exactPartitionMatches },
    { label: "v1 clusters split by projection", value: metrics.v1ClusterSplits },
    { label: "projected v2 profiles spanning v1", value: metrics.projectedV2Merges },
    { label: "same pairs in both", value: metrics.sameInBothPairs },
    { label: "v1 same / v2 different", value: metrics.v1SameV2DifferentPairs },
    { label: "v2 same / v1 different", value: metrics.v2SameV1DifferentPairs },
  ]), [
    metrics.bothAssignedReads,
    metrics.exactPartitionMatches,
    metrics.neitherAssignedReads,
    metrics.projectedV2Merges,
    metrics.sameInBothPairs,
    metrics.v1AssignedReads,
    metrics.v1ClusterSplits,
    metrics.v1OnlyReads,
    metrics.v1SameV2DifferentPairs,
    metrics.v2OnlyReads,
    metrics.v2SameV1DifferentPairs,
  ]);

  useEffect(() => {
    if (!runId || restoredBatchRun.current === runId) return;
    restoredBatchRun.current = runId;
    if ([1, 5, 25, 250].includes(persistedBatchSize)) {
      setBatchSize(String(persistedBatchSize));
    }
  }, [persistedBatchSize, runId]);

  useEffect(() => {
    if (!polling) return undefined;
    let stopped = false;
    let inFlight = false;
    const timer = window.setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = overviewFromResult(await getVehicleReidV2ConversionPreviewOverview());
        if (!stopped) setOverview(next);
      } catch (error) {
        if (!stopped) setMessage(error.message);
      } finally {
        inFlight = false;
      }
    }, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [polling]);

  const perform = async (name, operation, successMessage) => {
    setBusy(name);
    setMessage("");
    try {
      const result = await operation();
      setOverview(overviewFromResult(result));
      setMessage(typeof successMessage === "function" ? successMessage(result) : successMessage);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };

  const startPreview = () => perform(
    "start",
    () => startVehicleReidV2ConversionPreview({ batchSize: Number(batchSize) }),
    "Conversion preview started. It freezes evidence and projects identity only; no authoritative v2 profile or read assignment is written."
  );

  const processBatch = () => perform(
    "process",
    () => processVehicleReidV2ConversionPreviewBatch({
      runId,
      limit: Number(batchSize),
    }),
    (result) => {
      const processed = count(
        result?.data?.operation?.processed ?? result?.data?.operation?.processedCount
          ?? result?.data?.batch?.processed
          ?? result?.data?.processed ?? result?.data?.preview?.processed
      );
      return `Processed ${processed.toLocaleString()} read${processed === 1 ? "" : "s"} in the preview only.`;
    }
  );

  const togglePaused = () => {
    const paused = status !== "paused";
    return perform(
      "pause",
      () => setVehicleReidV2ConversionPreviewPaused({ runId, paused }),
      paused ? "Conversion preview paused after the current item." : "Conversion preview resumed."
    );
  };

  const cancelPreview = () => perform(
    "cancel",
    () => cancelVehicleReidV2ConversionPreview({ runId }),
    "Remaining conversion-preview work was cancelled. ReID v1 and all authoritative identity data remain unchanged."
  );

  const verifyPreview = () => perform(
    "verify",
    () => verifyVehicleReidV2ConversionPreview({ runId, previewFingerprint }),
    (result) => result?.data?.operation?.failed === true
      ? "Fingerprint verification failed and was recorded. This preview cannot be used until a later verification succeeds."
      : result?.data?.operation?.current === false
        ? "Evidence changed after the freeze. Rebuild the preview before any later-stage use."
        : "The frozen evidence and preview fingerprints were verified. This verification did not write authoritative identities."
  );

  const retryJob = (jobId) => perform(
    `retry:${jobId}`,
    () => retryVehicleReidV2ConversionPreviewJob({ jobId }),
    "The preview item was queued for its one bounded operator retry."
  );

  const acceptPreview = () => {
    if (!window.confirm("Accept this exact verified preview fingerprint for Stage 2 materialization? This records approval but does not switch consumers.")) return;
    return perform(
      "accept",
      () => acceptVehicleReidV2ConversionPreview({ runId, previewFingerprint }),
      "The exact verified preview was accepted. No authoritative rows or consumer cutover were written yet."
    );
  };

  const materializePreview = () => {
    if (!window.confirm("Materialize the accepted frozen preview into authoritative ReID profiles and assignments? ReID v1 remains primary until a separate cutover.")) return;
    return perform(
      "materialize",
      () => materializeVehicleReidV2ConversionPreview({ runId, previewFingerprint }),
      "The accepted preview was materialized exactly. ReID v1 remains primary until the separate cutover control is confirmed."
    );
  };

  const cutoverToV2 = () => {
    if (!window.confirm("Switch Live Feed, Vehicle Search, Profiles, Review, and profile links to authoritative ReID v2 now? The v1 rollback path remains available.")) return;
    return perform(
      "cutover",
      () => transitionVehicleReidAuthorityMode({
        mode: "v2_primary",
        runId,
        reason: "Explicit Stage 2 operator cutover after exact materialization and fingerprint verification.",
      }),
      "Authoritative ReID v2 is now primary. ReID v1 remains retained for the rollback window."
    );
  };

  const rollbackToV1 = () => {
    if (!window.confirm("Roll consumers back to ReID v1? Authoritative v2 rows are retained unchanged for diagnosis and a later controlled return.")) return;
    return perform(
      "rollback",
      () => transitionVehicleReidAuthorityMode({
        mode: "v1_rollback",
        reason: "Explicit Stage 2 operator rollback to retained ReID v1 consumers.",
      }),
      "Consumers were rolled back to ReID v1. Authoritative v2 evidence remains retained."
    );
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <GitCompareArrows className="h-5 w-5" /> ReID authoritative conversion and cutover
            </CardTitle>
            <CardDescription className="mt-1 max-w-3xl">
              Build and verify a frozen projection, materialize its exact authoritative rows, and switch consumers only after reconciliation succeeds.
            </CardDescription>
          </div>
          <Badge variant={statusVariant(status)}>{STATUS_LABELS[status] || status.replaceAll("_", " ")}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <div className="font-semibold">{["accepted", "running", "completed", "rolled_back"].includes(status) ? "Stage 2 controlled materialization" : "Stage 1 conversion preview"}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Preview controls create no authoritative identity. Stage 2 acceptance, materialization, and consumer cutover are separate confirmed operations. Materialization does not change the current identity source; only the explicit cutover control changes consumers, and the retained v1 rollback remains available.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Current v1 assignments are comparison evidence only and never create v2 identity. Exact effective or corrected plates and audited human Same reviews may connect evidence; Different, Unsure, ambiguous, stale, or conflicting evidence fails closed. Cosine similarity never establishes identity by itself.
          </p>
        </div>

        {overview ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-md border p-3">
              <div className="font-mono text-sm font-semibold">{controlMode}</div>
              <div className="text-xs text-muted-foreground">transition mode</div>
            </div>
            <Metric label="authoritative v2 profiles" value={authoritativeProfiles} />
            <Metric label="authoritative v2 members" value={authoritativeMembers} />
            <Metric label="authoritative v2 read assignments" value={authoritativeAssignments} />
          </div>
        ) : null}

        {run ? (
          <>
            <div className="space-y-4 rounded-md border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-medium">Conversion preview #{runId || "unknown"}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatCount(processedReads)} of {formatCount(totalReads)} frozen reads processed
                    {retryableReads ? ` · ${formatCount(retryableReads)} retryable` : ""}
                    {failedReads ? ` · ${formatCount(failedReads)} terminal failure${failedReads === 1 ? "" : "s"}` : ""}
                  </div>
                </div>
                <Badge variant="outline">{formatCount(remainingReads)} remaining</Badge>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Preview progress</span><span>{progress}%</span>
                </div>
                <Progress value={progress} aria-label={`${progress}% of ReID v2 conversion preview processed`} />
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[10rem] space-y-2">
                  <Label>Next preview batch</Label>
                  <Select value={batchSize} onValueChange={setBatchSize}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {BATCH_SIZES.map((size) => (
                        <SelectItem key={size} value={String(size)}>{size} read{size === 1 ? "" : "s"}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="button" disabled={Boolean(busy) || !canProcess} onClick={processBatch}>
                  {busy === "process" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                  {claimableReads
                    ? `Process preview batch (${Math.min(Number(batchSize), claimableReads)})`
                    : "Finalize preview state"}
                </Button>
                {canPause ? (
                  <Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={togglePaused}>
                    {busy === "pause"
                      ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      : status === "paused"
                        ? <Play className="mr-2 h-4 w-4" />
                        : <Pause className="mr-2 h-4 w-4" />}
                    {status === "paused" ? "Resume preview" : "Pause preview"}
                  </Button>
                ) : null}
                {canCancel ? (
                  <Button type="button" variant="destructive" disabled={Boolean(busy)} onClick={cancelPreview}>
                    {busy === "cancel" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
                    Cancel preview
                  </Button>
                ) : null}
                <Button type="button" variant="outline" disabled={Boolean(busy) || !canVerify} onClick={verifyPreview}>
                  {busy === "verify" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                  Verify frozen preview
                </Button>
              </div>
              {status === "failed" || failedReads ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                  <div className="font-medium">Preview processing needs attention</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {run.lastErrorCode || "PREVIEW_JOB_EXHAUSTED"}
                    {failedReads ? ` · ${formatCount(failedReads)} terminal job failure${failedReads === 1 ? "" : "s"}` : ""}
                  </p>
                </div>
              ) : null}
            </div>

            <section className="space-y-3">
              <div>
                <h3 className="font-medium">Projected authoritative v2 identity</h3>
                <p className="text-xs text-muted-foreground">
                  {status === "completed" || status === "rolled_back"
                    ? "These frozen projection counts are retained as the materialization contract; current-contract authority health appears below."
                    : ["accepted", "running"].includes(status)
                      ? "These frozen projection counts are the exact contract being materialized."
                      : "Projection counts only; no authoritative profile or assignment is written until the separately confirmed Stage 2 materialization step."}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {projectionMetrics.map((metric) => <Metric key={metric.label} {...metric} />)}
              </div>
              {sampleProfiles.length ? (
                <details className="rounded-md border">
                  <summary className="cursor-pointer p-3 text-sm font-medium">Projected profile samples</summary>
                  <div className="space-y-2 border-t p-3">
                    {sampleProfiles.map((profile, index) => {
                      const profileKey = profile.profileKey || profile.projectionKey || profile.id;
                      const memberCount = count(profile.memberCount ?? profile.members?.length);
                      const profileKind = profile.profileKind
                        || (profile.provisional || memberCount === 1 ? "provisional singleton" : "multi-member");
                      const anchorPlates = Array.isArray(profile.anchorPlates) ? profile.anchorPlates : [];
                      return (
                        <div key={profileKey || index} className="rounded-md border p-3 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="font-medium capitalize">{String(profileKind).replaceAll("_", " ")}</div>
                            <Badge variant="outline">{formatCount(memberCount)} member{memberCount === 1 ? "" : "s"}</Badge>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {profile.evidenceBasis ? `${String(profile.evidenceBasis).replaceAll("_", " ")} · ` : ""}
                            {formatCount(profile.readCount)} mapped read{count(profile.readCount) === 1 ? "" : "s"}
                            {anchorPlates.length ? ` · ${anchorPlates.join(", ")}` : ""}
                          </div>
                          {profileKey ? <code className="mt-1 block break-all text-xs text-muted-foreground">{profileKey}</code> : null}
                        </div>
                      );
                    })}
                  </div>
                </details>
              ) : null}
            </section>

            <section className="space-y-3">
              <div>
                <h3 className="font-medium">Assignment basis and fail-closed outcomes</h3>
                <p className="text-xs text-muted-foreground">Shared canonical assets count once. Historical and nighttime reads require trustworthy exact-plate evidence when no eligible canonical image exists.</p>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {assignmentMetrics.map((metric) => <Metric key={metric.label} {...metric} />)}
              </div>
            </section>

            <section className="space-y-3 rounded-md border border-blue-500/30 bg-blue-500/5 p-4">
              <div className="flex items-start gap-2">
                <GitCompareArrows className="mt-0.5 h-4 w-4 flex-none" />
                <div>
                  <h3 className="font-medium">Current v1 comparison — observation only</h3>
                  <p className="text-xs text-muted-foreground">These counts measure agreement and disagreement after the v2 projection. A v1 cluster is never used to join, split, or assign v2 identity.</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {comparisonMetrics.map((metric) => <Metric key={metric.label} {...metric} />)}
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center gap-2 font-medium"><Fingerprint className="h-4 w-4" />Frozen evidence fingerprints</div>
              <div className="grid gap-3 lg:grid-cols-2">
                <FingerprintValue label="Source candidate fingerprint" value={sourceProfileCandidateFingerprint} />
                <FingerprintValue label="Identity evidence fingerprint" value={identityEvidenceFingerprint} />
                <FingerprintValue label="Conversion preview fingerprint" value={previewFingerprint} />
                <FingerprintValue label="Last revalidation fingerprint" value={lastRevalidationFingerprint} />
              </div>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>Algorithm: <code>{algorithmVersion || "Not recorded"}</code></span>
                <span>·</span>
                <span>Last verification: {formatDateTime(lastRevalidatedAt)}</span>
                {lastRevalidationStatus === "stale" || verification.matches === false
                  || verification.valid === false
                  ? <Badge variant="destructive">Fingerprint mismatch</Badge>
                  : lastRevalidationStatus === "failed"
                    ? <Badge variant="destructive">Verification failed</Badge>
                  : lastRevalidationStatus === "current"
                    || verification.matches === true
                    || verification.valid === true
                    ? <Badge>Exact fingerprint match</Badge>
                    : <Badge variant="outline">Not verified</Badge>}
              </div>
            </section>

            <details className="rounded-md border">
              <summary className="cursor-pointer p-3 text-sm font-medium">Conflict and unavailable evidence</summary>
              <div className="space-y-3 border-t p-3 text-sm">
                {Object.keys(dispositionCounts).length ? (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    {Object.entries(dispositionCounts).map(([reason, value]) => (
                      <div key={reason} className="rounded-md border p-2">
                        <div className="font-medium tabular-nums">{formatCount(value)}</div>
                        <div className="break-words text-xs text-muted-foreground">{reason.replaceAll("_", " ")}</div>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-muted-foreground">No disposition details are available yet.</p>}
                {conflicts.length ? (
                  <div className="space-y-2">
                    <div className="font-medium">Preserved conflicts</div>
                    {conflicts.map((conflict, index) => (
                      <div key={conflict.conflictKey || index} className="flex gap-2 rounded-md border border-amber-500/30 p-3">
                        <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-amber-600" />
                        <div>
                          <div className="font-medium">{conflict.reason || "Identity evidence conflict"}</div>
                          <div className="break-all text-xs text-muted-foreground">{conflict.conflictKey || "No conflict fingerprint"}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </details>

            {retryCandidates.length ? (
              <details className="rounded-md border">
                <summary className="cursor-pointer p-3 text-sm font-medium">Preview failures eligible for one bounded retry</summary>
                <div className="space-y-2 border-t p-3">
                  {retryCandidates.map((candidate, index) => {
                    const jobId = candidate.jobId || candidate.id;
                    return (
                      <div key={jobId || index} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
                        <div>
                          <div className="font-medium">{candidate.readId ? `Read #${candidate.readId}` : `Preview item #${jobId || index + 1}`}</div>
                          <div className="text-xs text-muted-foreground">
                            {candidate.errorCode || "Preview failure"}{candidate.errorMessage ? ` · ${candidate.errorMessage}` : ""}
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={Boolean(busy) || !jobId || count(candidate.operatorRetryCount) >= 1}
                          onClick={() => retryJob(jobId)}
                        >
                          {busy === `retry:${jobId}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                          Retry once
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </details>
            ) : null}
          </>
        ) : (
          <div className="space-y-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <p>No conversion preview exists. Start one to freeze the current canonical crop, embedding, plate, review, source-link, and candidate-profile evidence without creating authoritative identities.</p>
            <div className="max-w-[12rem] space-y-2 text-foreground">
              <Label>Initial preview batch</Label>
              <Select value={batchSize} onValueChange={setBatchSize}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {BATCH_SIZES.map((size) => (
                    <SelectItem key={size} value={String(size)}>{size} read{size === 1 ? "" : "s"}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={Boolean(busy) || !canStart} onClick={startPreview}>
            {busy === "start" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}
            {run ? "Start new frozen preview" : "Start conversion preview"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => perform("refresh", getVehicleReidV2ConversionPreviewOverview, "Conversion preview status refreshed.")}
          >
            {busy === "refresh" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh status
          </Button>
        </div>

        {run ? (
          <section className="space-y-3 rounded-md border p-4">
            <div>
              <p className="font-medium">Stage 2 authority controls</p>
              <p className="text-xs text-muted-foreground">
                Each step rechecks the exact frozen evidence. Acceptance writes approval only; materialization writes the exact projected profiles and assignments; cutover changes consumers only after database reconciliation succeeds.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" disabled={Boolean(busy) || !canAccept} onClick={acceptPreview}>
                {busy === "accept" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                Accept verified preview
              </Button>
              <Button type="button" variant="secondary" disabled={Boolean(busy) || !canMaterialize} onClick={materializePreview}>
                {busy === "materialize" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Database className="mr-2 h-4 w-4" />}
                Materialize authoritative ReID
              </Button>
              <Button type="button" disabled={Boolean(busy) || !canCutover} onClick={cutoverToV2}>
                {busy === "cutover" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Power className="mr-2 h-4 w-4" />}
                Make ReID v2 primary
              </Button>
              <Button type="button" variant="destructive" disabled={Boolean(busy) || !canRollback} onClick={rollbackToV1}>
                {busy === "rollback" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                Roll back consumers to v1
              </Button>
            </div>
          </section>
        ) : null}

        {status === "completed" || controlMode === "v2_primary" || controlMode === "v1_rollback" ? (
          <section className="space-y-3 rounded-md border p-4">
            <div>
              <p className="font-medium">Authoritative ReID health</p>
              <p className="text-xs text-muted-foreground">
                Stored, reconciled authority counts. Identity consumers still revalidate exact current source links, embeddings, and review evidence on every read.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="current profiles" value={authorityCounts.profiles} detail={`${formatCount(authorityCounts.multiMemberProfiles)} multi-member · ${formatCount(authorityCounts.singletonProfiles)} singleton`} />
              <Metric label="assigned reads" value={authorityCounts.assignments} detail={`${formatCount(authorityCounts.unassignedReads)} safely unassigned`} />
              <Metric label="exact-plate-only" value={authorityCounts.exactPlateAssignments} detail={`${formatCount(authorityCounts.sharedAssetAssignments)} shared-asset assignments`} />
              <Metric label="plate anchors" value={authorityCounts.plateAnchors} detail={`${formatCount(liveJobs.conflict)} live conflicts`} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="live pending" value={liveJobs.pending} />
              <Metric label="live processing" value={liveJobs.processing} />
              <Metric label="live ready" value={liveJobs.ready} />
              <Metric label="live exceptions" value={count(liveJobs.conflict) + count(liveJobs.unavailable) + count(liveJobs.failed)} detail={`worker ${text(liveWorker.phase) || "starting"}`} />
            </div>
          </section>
        ) : null}

        {message ? <p role="status" className="rounded-md border p-3 text-sm">{message}</p> : null}
      </CardContent>
    </Card>
  );
}
