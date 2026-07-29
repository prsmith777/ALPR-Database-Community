"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Gauge,
  HardDrive,
  Image as ImageIcon,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  TimerReset,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

const countFormatter = new Intl.NumberFormat();

function formatBytes(value) {
  if (!Number.isFinite(value)) return "Unavailable";
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** unit;
  return `${amount.toFixed(amount >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatCount(value) {
  return Number.isFinite(value) ? countFormatter.format(value) : "Unavailable";
}

function formatDate(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

function Metric({ icon: Icon, label, value, detail }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function Projection({ projection }) {
  let detail = "Capacity measurement unavailable";
  if (projection.status === "reached") detail = "Already at or above this threshold";
  if (projection.status === "stable") detail = "No current growth estimate";
  if (projection.status === "projected") {
    detail = `${formatDate(projection.projectedAt)} · about ${formatCount(projection.days)} days`;
  }

  return (
    <div className="flex items-start justify-between gap-4 border-t py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div>
        <p className="font-medium">{projection.percent}% filesystem use</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <Badge variant={projection.status === "reached" ? "destructive" : "outline"}>
        {projection.status === "projected" ? "Estimated" : projection.status}
      </Badge>
    </div>
  );
}

export default function StorageHealthCard({ snapshot }) {
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();
  const filesystem = snapshot?.filesystem;
  const database = snapshot?.database;
  const assets = snapshot?.assets;
  const growth = snapshot?.growth;
  const breakdown = snapshot?.breakdown;
  const maintenance = snapshot?.maintenance;
  const preview = maintenance?.lastResult;
  const reconciliation = snapshot?.reconciliation;
  const reconciliationRun = reconciliation?.run;
  const indexedTotal = assets
    ? assets.readyCount + assets.failedCount + assets.pendingCount
    : 0;
  const indexedPercent = indexedTotal
    ? Number((assets.readyCount / indexedTotal * 100).toFixed(1))
    : 0;

  return (
    <Card className="max-w-5xl">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="h-5 w-5 text-primary" aria-hidden="true" />
              Storage health
            </CardTitle>
            <Badge variant="secondary" className="gap-1">
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              Read only
            </Badge>
          </div>
          <CardDescription className="mt-2">
            Capacity, database, capture, and visual-index measurements. This view cannot delete or modify data.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isRefreshing}
          onClick={() => startRefresh(() => router.refresh())}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} aria-hidden="true" />
          {isRefreshing ? "Refreshing" : "Refresh"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {snapshot?.errors?.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
            <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              Some measurements are unavailable
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
              {snapshot.errors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          </div>
        )}

        {filesystem && (
          <section aria-labelledby="filesystem-capacity-title" className="rounded-lg border p-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 id="filesystem-capacity-title" className="font-semibold">Mounted filesystem capacity</h3>
                <p className="text-sm text-muted-foreground">
                  {formatBytes(filesystem.usedBytes)} used · {formatBytes(filesystem.availableBytes)} available
                </p>
              </div>
              <span className="text-2xl font-semibold">{filesystem.usedPercent}%</span>
            </div>
            <Progress
              value={filesystem.usedPercent}
              aria-label={`${filesystem.usedPercent}% of the mounted capture filesystem is used`}
              className="mt-3"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Total mounted capacity: {formatBytes(filesystem.totalBytes)}. This includes anything else sharing the same filesystem.
            </p>
          </section>
        )}

        <section aria-labelledby="storage-breakdown-title" className="rounded-lg border p-4">
          <div>
            <h3 id="storage-breakdown-title" className="font-semibold">Storage breakdown</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Application categories are measured from their approved roots. Docker and backups require a current read-only host snapshot.
            </p>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Metric
              icon={ImageIcon}
              label="Source images"
              value={formatBytes(breakdown?.sourceImages?.bytes)}
              detail={`${formatCount(breakdown?.sourceImages?.count)} files`}
            />
            <Metric
              icon={ImageIcon}
              label="Thumbnails"
              value={formatBytes(breakdown?.thumbnails?.bytes)}
              detail={`${formatCount(breakdown?.thumbnails?.count)} files`}
            />
            <Metric
              icon={ScanSearch}
              label="Derived vehicle images"
              value={formatBytes(breakdown?.derivedVehicleImages?.bytes)}
              detail={`${formatCount(breakdown?.derivedVehicleImages?.count)} files`}
            />
            <Metric
              icon={Database}
              label="PostgreSQL"
              value={formatBytes(breakdown?.database?.bytes)}
              detail="Current database size"
            />
            <Metric
              icon={HardDrive}
              label="Docker"
              value={formatBytes(breakdown?.docker?.bytes)}
              detail={breakdown?.docker
                ? `${formatBytes(breakdown.docker.imagesBytes)} images · ${formatBytes(breakdown.docker.buildCacheBytes)} build cache`
                : "Host snapshot unavailable"}
            />
            <Metric
              icon={ShieldCheck}
              label="Verified backups"
              value={formatBytes(breakdown?.backups?.bytes)}
              detail={breakdown?.backups
                ? `${formatCount(breakdown.backups.count)} backups · latest ${formatDate(breakdown.backups.latestVerifiedAt)}`
                : "Host snapshot unavailable"}
            />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Category measurement: {formatDate(breakdown?.measuredAt)}. Host snapshot: {formatDate(breakdown?.hostSnapshotMeasuredAt)}.
          </p>
        </section>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            icon={Database}
            label="PostgreSQL database"
            value={formatBytes(database?.totalBytes)}
            detail={`${formatCount(database?.readCount)} plate reads · ${formatCount(database?.plateCount)} plate summaries`}
          />
          <Metric
            icon={Gauge}
            label="Recent ingestion"
            value={`${formatCount(database?.readsPerDay)} / day`}
            detail={`${formatCount(database?.readsLast24Hours)} in 24 hours · seven-day average`}
          />
          <Metric
            icon={ImageIcon}
            label="Capture references"
            value={formatCount(database?.imageReferenceCount)}
            detail={`${formatCount(database?.recordsWithoutImagePath)} reads have no source-image path`}
          />
          <Metric
            icon={CheckCircle2}
            label="Visual index"
            value={`${formatCount(assets?.readyCount)} ready`}
            detail={`${indexedPercent}% · ${formatCount(assets?.pendingCount)} pending · ${formatCount(assets?.failedCount)} failed`}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section aria-labelledby="measurement-detail-title" className="rounded-lg border p-4">
            <h3 id="measurement-detail-title" className="font-semibold">Measurement detail</h3>
            <dl className="mt-3 space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Index-confirmed missing sources</dt>
                <dd className="font-medium">{formatCount(assets?.sourceMissingCount)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Estimated storage per new read</dt>
                <dd className="font-medium">{formatBytes(growth?.estimatedBytesPerRead)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Estimated daily growth</dt>
                <dd className="font-medium">{formatBytes(growth?.estimatedBytesPerDay)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Last visual asset indexed</dt>
                <dd className="text-right font-medium">{formatDate(assets?.lastIndexedAt)}</dd>
              </div>
            </dl>
            {assets && (
              <p className="mt-4 text-xs text-muted-foreground">
                Bytes/read samples up to {formatCount(assets.sampleLimit)} recent reads without recursively scanning storage.
                {assets.missingReferences > 0
                  ? ` ${formatCount(assets.missingReferences)} referenced sample files could not be read and were excluded.`
                  : " All referenced files in the sample were readable."}
              </p>
            )}
          </section>

          <section aria-labelledby="projection-title" className="rounded-lg border p-4">
            <h3 id="projection-title" className="font-semibold">Capacity threshold projection</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Capture-growth estimate only; database overhead, logs, backups, and other filesystem users can move these dates.
            </p>
            <div className="mt-4">
              {growth?.projections?.map((projection) => (
                <Projection key={projection.percent} projection={projection} />
              )) || <p className="text-sm text-muted-foreground">Projection unavailable.</p>}
            </div>
          </section>
        </div>

        <section aria-labelledby="maintenance-preview-title" className="rounded-lg border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="maintenance-preview-title" className="flex items-center gap-2 font-semibold">
                <TimerReset className="h-4 w-4 text-primary" aria-hidden="true" />
                Scheduled maintenance preview
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Retention and record-limit candidates are calculated outside plate ingestion. This job is dry-run only.
              </p>
            </div>
            <Badge variant={maintenance?.status === "failed" ? "destructive" : "secondary"}>
              {maintenance ? `${maintenance.status} - ${maintenance.mode}` : "Not available"}
            </Badge>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Next scheduled check</dt>
              <dd className="mt-1 font-medium">{formatDate(maintenance?.nextRunAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last completed</dt>
              <dd className="mt-1 font-medium">{formatDate(maintenance?.lastCompletedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Record-limit candidates</dt>
              <dd className="mt-1 font-medium">{formatCount(preview?.recordPruning?.candidateReads)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Retention-eligible reads</dt>
              <dd className="mt-1 font-medium">{formatCount(preview?.retention?.eligibleReads)}</dd>
            </div>
          </dl>
          {maintenance?.lastError && (
            <p className="mt-3 text-sm text-destructive">Last preview failed: {maintenance.lastError}</p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Candidate totals use database references only. No recursive filesystem reconciliation is performed yet.
          </p>
        </section>

        <section aria-labelledby="storage-reconciliation-title" className="rounded-lg border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="storage-reconciliation-title" className="flex items-center gap-2 font-semibold">
                <ScanSearch className="h-4 w-4 text-primary" aria-hidden="true" />
                Read-only storage reconciliation
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                A resumable bounded scan compares approved storage roots with database references without changing either one.
              </p>
            </div>
            <Badge variant={reconciliation?.status === "failed" ? "destructive" : "secondary"}>
              {reconciliationRun
                ? `${reconciliationRun.status} - ${reconciliationRun.phase}`
                : reconciliation ? `${reconciliation.status} - read-only` : "Not available"}
            </Badge>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Files inspected</dt>
              <dd className="mt-1 font-medium">{formatCount(reconciliationRun?.filesScanned)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Database paths checked</dt>
              <dd className="mt-1 font-medium">{formatCount(reconciliationRun?.referencesChecked)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Orphaned files</dt>
              <dd className="mt-1 font-medium">
                {formatCount(reconciliationRun?.orphanFiles)} ({formatBytes(reconciliationRun?.orphanBytes)})
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Missing referenced paths</dt>
              <dd className="mt-1 font-medium">{formatCount(reconciliationRun?.missingReferencePaths)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Started</dt>
              <dd className="mt-1 font-medium">{formatDate(reconciliationRun?.scanStartedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Completed</dt>
              <dd className="mt-1 font-medium">{formatDate(reconciliationRun?.completedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Recent files deferred</dt>
              <dd className="mt-1 font-medium">{formatCount(reconciliationRun?.recentFilesSkipped)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Skipped/errors</dt>
              <dd className="mt-1 font-medium">
                {formatCount(reconciliationRun?.skippedEntries)} / {formatCount(reconciliationRun?.errorCount)}
              </dd>
            </div>
          </dl>
          {reconciliation?.findings?.length > 0 && (
            <div className="mt-4 rounded-md border p-3">
              <p className="text-sm font-medium">Finding sample (up to 25)</p>
              <ul className="mt-2 max-h-52 space-y-2 overflow-y-auto text-xs">
                {reconciliation.findings.map((finding) => (
                  <li key={`${finding.findingType}:${finding.relativePath}`} className="flex flex-wrap gap-x-2">
                    <Badge variant="outline">{finding.findingType}</Badge>
                    <code className="break-all">{finding.relativePath}</code>
                    {finding.sizeBytes != null && <span className="text-muted-foreground">{formatBytes(finding.sizeBytes)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {reconciliation?.lastError && (
            <p className="mt-3 text-sm text-destructive">Last scan error: {reconciliation.lastError}</p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            The complete finding inventory is stored durably for review. Files created after a scan starts are deferred to the next run to avoid false orphan classifications.
          </p>
        </section>

        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-4 text-sm">
          <p className="font-medium text-blue-700 dark:text-blue-300">Measurement never performs cleanup</p>
          <p className="mt-1 text-muted-foreground">
            Refresh, retention previews, reconciliation, and category measurement do not delete anything. Guarded cleanup is a separate confirmed action below and is limited to generated, still-unreferenced derived files.
          </p>
        </div>

        <p className="text-xs text-muted-foreground">Measured {formatDate(snapshot?.measuredAt)}</p>
      </CardContent>
    </Card>
  );
}
