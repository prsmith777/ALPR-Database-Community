"use client";

import { useState, useTransition } from "react";
import { Archive, Download, RefreshCw, ShieldCheck } from "lucide-react";

import {
  createLoggingIncident,
  executeLoggingRetention,
  getLoggingRetentionOverview,
  previewLoggingRetention,
} from "@/app/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function HealthCard({ title, count, bytes, oldest, detail }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <p className="text-2xl font-semibold">{Number(count || 0).toLocaleString()}</p>
        <p className="text-sm text-muted-foreground">{formatBytes(bytes)}</p>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Oldest: {formatTime(oldest)}</p>
      {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

function scopeLabel(incident) {
  if (incident.scopeType === "request") return `Request ${incident.requestId}`;
  if (incident.scopeType === "read") return `Read ${incident.readId}`;
  return `${formatTime(incident.windowStart)} through ${formatTime(incident.windowEnd)}`;
}

export default function LoggingRetentionPanel({ initialOverview, canManage }) {
  const [overview, setOverview] = useState(initialOverview);
  const [notice, setNotice] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirmation, setConfirmation] = useState("");
  const [incident, setIncident] = useState({
    name: "",
    description: "",
    scopeType: "request",
    requestId: "",
    readId: "",
    windowStart: "",
    windowEnd: "",
    protectionDays: "30",
  });
  const [isPending, startTransition] = useTransition();

  const refresh = () => startTransition(async () => {
    const response = await getLoggingRetentionOverview();
    if (response?.success) setOverview(response.data);
    else setNotice({ kind: "error", text: response?.error || "Refresh failed." });
  });

  const submitIncident = (event) => {
    event.preventDefault();
    setNotice(null);
    startTransition(async () => {
      const response = await createLoggingIncident({
        ...incident,
        windowStart: incident.windowStart
          ? new Date(incident.windowStart).toISOString()
          : "",
        windowEnd: incident.windowEnd
          ? new Date(incident.windowEnd).toISOString()
          : "",
      });
      if (!response?.success) {
        setNotice({ kind: "error", text: response?.error || "Incident creation failed." });
        return;
      }
      setNotice({
        kind: "success",
        text: `Incident ${response.data.id} is protected and its evidence snapshot is ready to export.`,
      });
      setIncident((current) => ({ ...current, name: "", description: "" }));
      const refreshed = await getLoggingRetentionOverview();
      if (refreshed?.success) setOverview(refreshed.data);
    });
  };

  const runPreview = () => {
    setNotice(null);
    startTransition(async () => {
      const response = await previewLoggingRetention();
      if (!response?.success) {
        setNotice({ kind: "error", text: response?.error || "Preview failed." });
        return;
      }
      setPreview(response.data);
      setConfirmation("");
      setNotice({ kind: "success", text: "Preview created without changing retained evidence." });
    });
  };

  const executePreview = () => {
    setNotice(null);
    startTransition(async () => {
      const response = await executeLoggingRetention({
        previewToken: preview?.previewToken,
        confirmation,
      });
      if (!response?.success) {
        setNotice({ kind: "error", text: response?.error || "Retention execution failed." });
        return;
      }
      setNotice({
        kind: "success",
        text: `Archived ${response.data.archivedAuditCount} audit events and removed ${response.data.deletedReceiptCount} expired receipts.`,
      });
      setPreview(null);
      setConfirmation("");
      const refreshed = await getLoggingRetentionOverview();
      if (refreshed?.success) setOverview(refreshed.data);
    });
  };

  const operational = overview.operationalLog || {};
  const audit = overview.audit || {};
  const policy = overview.policy || {};

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Logging retention and incident evidence</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Measure retained evidence, preserve an immutable incident package, and archive only an exact confirmed preview. Scheduled execution is disabled.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={refresh} disabled={isPending}>
          <RefreshCw /> Refresh
        </Button>
      </div>

      {notice && (
        <Alert variant={notice.kind === "error" ? "destructive" : "default"}>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <HealthCard
          title="Operational files"
          count={operational.retainedFileCount}
          bytes={operational.retainedBytes}
          oldest={operational.oldestTimestamp}
          detail={`${formatBytes(operational.activeBytes)} active · ${operational.maximumFiles || 0} files configured`}
        />
        <HealthCard
          title="Ingress receipts"
          count={overview.receipts?.count}
          bytes={overview.receipts?.bytes}
          oldest={overview.receipts?.oldest}
          detail={`${overview.receipts?.candidateCount || 0} currently previewable`}
        />
        <HealthCard
          title="Read timeline"
          count={overview.pipeline?.count}
          bytes={overview.pipeline?.bytes}
          oldest={overview.pipeline?.oldest}
          detail="Retention follows its parent read"
        />
        <HealthCard
          title="Audit hot / archive"
          count={audit.hotCount}
          bytes={(audit.hotBytes || 0) + (audit.archiveBytes || 0)}
          oldest={audit.hotOldest}
          detail={`${audit.archiveCount || 0} archived · ${audit.candidateCount || 0} previewable`}
        />
      </div>

      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-emerald-500" />
          <h3 className="font-semibold">Incident protection and export</h3>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          The snapshot contains sanitized operational logs, receipts, read-timeline events, and audit events. It never includes request bodies, plate values, images, paths, or credentials. If the package cap is reached, the list reports how many matching rows were not copied.
        </p>

        {canManage && (
          <form className="mt-4 grid gap-3 lg:grid-cols-6" onSubmit={submitIncident}>
            <Input
              required
              placeholder="Incident name"
              value={incident.name}
              onChange={(event) => setIncident({ ...incident, name: event.target.value })}
            />
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={incident.scopeType}
              onChange={(event) => setIncident({ ...incident, scopeType: event.target.value })}
            >
              <option value="request">Request ID</option>
              <option value="read">Read ID</option>
              <option value="window">Time window</option>
            </select>
            {incident.scopeType === "request" && (
              <Input
                required
                placeholder="Request UUID"
                value={incident.requestId}
                onChange={(event) => setIncident({ ...incident, requestId: event.target.value })}
              />
            )}
            {incident.scopeType === "read" && (
              <Input
                required
                type="number"
                min="1"
                placeholder="Read ID"
                value={incident.readId}
                onChange={(event) => setIncident({ ...incident, readId: event.target.value })}
              />
            )}
            {incident.scopeType === "window" && (
              <>
                <Input
                  required
                  type="datetime-local"
                  value={incident.windowStart}
                  onChange={(event) => setIncident({ ...incident, windowStart: event.target.value })}
                />
                <Input
                  required
                  type="datetime-local"
                  value={incident.windowEnd}
                  onChange={(event) => setIncident({ ...incident, windowEnd: event.target.value })}
                />
              </>
            )}
            <Input
              type="number"
              min="1"
              max="3650"
              aria-label="Protection days"
              value={incident.protectionDays}
              onChange={(event) => setIncident({ ...incident, protectionDays: event.target.value })}
            />
            <Button type="submit" disabled={isPending}>Protect and snapshot</Button>
            <Input
              className="lg:col-span-5"
              placeholder="Optional description"
              value={incident.description}
              onChange={(event) => setIncident({ ...incident, description: event.target.value })}
            />
          </form>
        )}

        <div className="mt-5 overflow-x-auto rounded-md border">
          <table className="w-full min-w-[780px] text-left text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Incident</th>
                <th className="px-3 py-2">Scope</th>
                <th className="px-3 py-2">Protected through</th>
                <th className="px-3 py-2">Evidence</th>
                <th className="px-3 py-2 text-right">Export</th>
              </tr>
            </thead>
            <tbody>
              {(overview.incidents || []).map((item) => (
                <tr key={item.id} className="border-t">
                  <td className="px-3 py-2 font-medium">{item.name}</td>
                  <td className="px-3 py-2 text-muted-foreground">{scopeLabel(item)}</td>
                  <td className="px-3 py-2">{formatTime(item.protectedUntil)}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {Object.values(item.evidenceCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0)} entries
                    {Object.values(item.truncatedCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0) > 0
                      ? ` · ${Object.values(item.truncatedCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0)} matching rows not copied`
                      : ""}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button asChild size="sm" variant="outline">
                      <a href={`/api/logs/incidents/${item.id}/export`}>
                        <Download /> JSON
                      </a>
                    </Button>
                  </td>
                </tr>
              ))}
              {!overview.incidents?.length && (
                <tr><td colSpan="5" className="px-3 py-8 text-center text-muted-foreground">No incident packages yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Archive className="h-5 w-5" />
              <h3 className="font-semibold">Preview-first retention</h3>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Receipts older than {policy.receiptRetentionDays} days or beyond {Number(policy.receiptMaximumRows || 0).toLocaleString()} rows are removable. Audit events older than {policy.auditHotRetentionDays} days move to the immutable partitioned archive. Active incidents are excluded.
            </p>
          </div>
          {canManage && (
            <Button type="button" variant="outline" onClick={runPreview} disabled={isPending}>
              Create retention preview
            </Button>
          )}
        </div>

        {preview && (
          <div className="mt-4 rounded-md border border-amber-500/50 bg-amber-500/5 p-4">
            <p className="font-medium">
              Preview {preview.id}: {preview.candidateCount} rows · {formatBytes(preview.candidateBytes)}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {preview.auditEventCount} audit events will be archived; {preview.receiptCount} expired receipts will be removed. Expires {formatTime(preview.expiresAt)}.
            </p>
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer font-medium">Show exact candidate IDs</summary>
              <div className="mt-2 max-h-36 space-y-2 overflow-y-auto rounded border bg-background p-3 font-mono text-xs">
                <p className="break-all">
                  Receipt IDs: {preview.receiptIds?.length ? preview.receiptIds.join(", ") : "none"}
                </p>
                <p className="break-all">
                  Audit event IDs: {preview.auditEventIds?.length ? preview.auditEventIds.join(", ") : "none"}
                </p>
              </div>
            </details>
            {preview.candidateCount > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Input
                  className="max-w-sm"
                  placeholder={preview.confirmationPhrase}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
                <Button
                  type="button"
                  variant="destructive"
                  onClick={executePreview}
                  disabled={isPending || confirmation !== preview.confirmationPhrase}
                >
                  Archive exact preview
                </Button>
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Nothing is currently eligible; no execution is offered.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
