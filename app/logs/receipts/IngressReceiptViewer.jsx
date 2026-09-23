"use client";

import Link from "next/link";
import { useCallback, useState, useTransition } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  RefreshCw,
  ScrollText,
  SlidersHorizontal,
  X,
} from "lucide-react";

import { getIntegrationIngressReceipts } from "@/app/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/browser-clipboard.mjs";

function defaultFilters(pageSize = 50) {
  return {
    requestId: "",
    readId: "",
    cameraName: "",
    outcome: "",
    errorCode: "",
    startAt: "",
    endAt: "",
    pageSize: String(pageSize),
  };
}

function actionFilters(filters, page) {
  const timestamp = (value) => {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  };
  return {
    ...filters,
    page,
    pageSize: Number(filters.pageSize),
    startAt: timestamp(filters.startAt),
    endAt: timestamp(filters.endAt),
  };
}

function appliedFilterLabels(filters) {
  const labels = [];
  if (filters.requestId) labels.push(`Request: ${filters.requestId}`);
  if (filters.readId) labels.push(`Read: ${filters.readId}`);
  if (filters.cameraName) labels.push(`Camera: ${filters.cameraName}`);
  if (filters.outcome) labels.push(`Outcome: ${filters.outcome}`);
  if (filters.errorCode === "__any__") labels.push("Any error");
  else if (filters.errorCode) labels.push(`Error: ${filters.errorCode}`);
  if (filters.startAt) labels.push(`From: ${filters.startAt}`);
  if (filters.endAt) labels.push(`Through: ${filters.endAt}`);
  return labels;
}

function formatTimestamp(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return (
    <time dateTime={value} className="whitespace-nowrap">
      {date.toLocaleString()}
    </time>
  );
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FilterSelect({ label, value, onChange, children }) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground shadow-sm"
      >
        {children}
      </select>
    </label>
  );
}

function Detail({ label, children, wide = false }) {
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2 lg:col-span-3")}>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-foreground">{children || "—"}</dd>
    </div>
  );
}

function ReceiptDetails({ receipt }) {
  const heavyFields = Object.entries(receipt.heavyFields || {});
  return (
    <div className="rounded-md border border-border/70 bg-muted/20 p-3">
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <Detail label="Receipt schema">v{receipt.receiptSchemaVersion || 1}</Detail>
        <Detail label="Integration">{receipt.integration}</Detail>
        <Detail label="Route">{receipt.routeName}</Detail>
        <Detail label="Request">{[receipt.method, receipt.contentType].filter(Boolean).join(" · ")}</Detail>
        <Detail label="Body size">{formatBytes(receipt.bodyBytes)}</Detail>
        <Detail label="Event timestamp">{receipt.eventTimestampText}</Detail>
        <Detail label="Completed">{formatTimestamp(receipt.completedAt)}</Detail>
        <Detail label="Trigger aliases" wide>
          {receipt.triggerAliasFields.length
            ? receipt.triggerAliasFields.join(", ")
            : "No trigger alias supplied"}
          {receipt.triggerAliasConflict
            ? ` · conflict across ${receipt.triggerAliasDistinctValueCount} distinct states or values`
            : receipt.triggerAliasFields.length > 1
              ? " · consistent"
              : ""}
        </Detail>
        <Detail label="Payload keys" wide>
          {receipt.payloadKeys.length ? receipt.payloadKeys.join(", ") : "None recorded"}
          {receipt.unknownPayloadKeyCount > 0
            ? ` · ${receipt.unknownPayloadKeyCount} unrecognized`
            : ""}
        </Detail>
        <Detail label="Large-field summaries" wide>
          {heavyFields.length
            ? heavyFields
                .map(([key, summary]) => `${key}: ${JSON.stringify(summary)}`)
                .join(" · ")
            : "None recorded"}
        </Detail>
        <Detail label="Body fingerprint" wide>
          <span className="font-mono text-xs">{receipt.bodySha256 || "Not recorded"}</span>
        </Detail>
      </dl>
    </div>
  );
}

function StatusBadge({ receipt }) {
  const failed = Boolean(receipt.errorCode) || (receipt.httpStatus || 0) >= 400;
  const pending = receipt.state !== "completed";
  return (
    <span
      className={cn(
        "inline-flex rounded border px-2 py-0.5 text-xs",
        failed
          ? "border-red-500/40 bg-red-500/10 text-red-500"
          : pending
            ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
            : "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
      )}
    >
      {receipt.outcome || receipt.state || "unknown"}
      {receipt.httpStatus ? ` · ${receipt.httpStatus}` : ""}
    </span>
  );
}

export default function IngressReceiptViewer({
  initialPage,
  initialFilters: requestedFilters = {},
  initialExpandFirst = false,
}) {
  const initialFilters = {
    ...defaultFilters(initialPage?.pageSize),
    ...requestedFilters,
  };
  const [pageData, setPageData] = useState(initialPage);
  const [draft, setDraft] = useState(initialFilters);
  const [applied, setApplied] = useState(initialFilters);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [expandedRows, setExpandedRows] = useState(() => {
    const firstReceiptId = initialExpandFirst
      ? initialPage?.receipts?.[0]?.id
      : null;
    return new Set(firstReceiptId ? [firstReceiptId] : []);
  });
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  const updateDraft = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const load = useCallback((filters, page = 1) => {
    startTransition(async () => {
      try {
        setError("");
        const response = await getIntegrationIngressReceipts(actionFilters(filters, page));
        if (!response?.success) {
          setError(response?.error || "Failed to read integration ingress receipts");
          return;
        }
        setPageData(response.data);
        setApplied(filters);
        setExpandedRows(new Set());
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to read integration ingress receipts"
        );
      }
    });
  }, []);

  const apply = (event) => {
    event?.preventDefault();
    setFiltersExpanded(false);
    load(draft, 1);
  };

  const clear = () => {
    const next = defaultFilters(pageData?.pageSize);
    setDraft(next);
    setFiltersExpanded(false);
    load(next, 1);
  };

  const toggleRow = (receiptId) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(receiptId)) next.delete(receiptId);
      else next.add(receiptId);
      return next;
    });
  };

  const activeLabels = appliedFilterLabels(applied);
  const hasUnappliedChanges = Object.keys(draft).some(
    (field) => draft[field] !== applied[field]
  );
  const receipts = pageData?.receipts || [];
  const facets = pageData?.facets || {};
  const firstRow = pageData?.total
    ? (pageData.page - 1) * pageData.pageSize + 1
    : 0;
  const lastRow = Math.min(pageData?.total || 0, pageData?.page * pageData?.pageSize);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form onSubmit={apply} className="flex-shrink-0 border-b bg-background">
        <div className="flex min-h-12 flex-wrap items-center gap-2 px-4 py-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={filtersExpanded}
            aria-controls="ingress-receipt-filters"
            onClick={() => setFiltersExpanded((expanded) => !expanded)}
          >
            <SlidersHorizontal aria-hidden="true" />
            Filters
            {activeLabels.length > 0 && (
              <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-5 text-primary-foreground">
                {activeLabels.length}
              </span>
            )}
            <ChevronDown
              className={cn("transition-transform", filtersExpanded && "rotate-180")}
              aria-hidden="true"
            />
          </Button>

          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap text-xs text-muted-foreground">
            {activeLabels.length ? (
              activeLabels.map((label) => (
                <span
                  key={label}
                  title={label}
                  className="max-w-64 shrink-0 truncate rounded border border-border bg-muted/40 px-2 py-1"
                >
                  {label}
                </span>
              ))
            ) : (
              <span>All ingress receipts · newest first</span>
            )}
            {hasUnappliedChanges && (
              <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-500">
                Unapplied changes
              </span>
            )}
          </div>

          <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:inline">
            {pageData?.metadata?.availableRows || 0} receipts retained
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => load(applied, pageData?.page || 1)}
          >
            <RefreshCw className={cn(isPending && "animate-spin")} aria-hidden="true" />
            Refresh
          </Button>
        </div>

        {filtersExpanded && (
          <div id="ingress-receipt-filters" className="border-t px-4 py-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="grid gap-1 text-xs text-muted-foreground">
                Request ID
                <Input
                  value={draft.requestId}
                  onChange={(event) => updateDraft("requestId", event.target.value)}
                  placeholder="Correlation UUID"
                  className="h-9"
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Read ID
                <Input
                  value={draft.readId}
                  onChange={(event) => updateDraft("readId", event.target.value)}
                  inputMode="numeric"
                  placeholder="40683"
                  className="h-9"
                />
              </label>
              <FilterSelect
                label="Camera"
                value={draft.cameraName}
                onChange={(value) => updateDraft("cameraName", value)}
              >
                <option value="">All cameras</option>
                {(facets.cameras || []).map((camera) => (
                  <option key={camera} value={camera}>{camera}</option>
                ))}
              </FilterSelect>
              <FilterSelect
                label="Outcome"
                value={draft.outcome}
                onChange={(value) => updateDraft("outcome", value)}
              >
                <option value="">All outcomes</option>
                {(facets.outcomes || []).map((outcome) => (
                  <option key={outcome} value={outcome}>{outcome}</option>
                ))}
              </FilterSelect>
              <FilterSelect
                label="Error"
                value={draft.errorCode}
                onChange={(value) => updateDraft("errorCode", value)}
              >
                <option value="">All receipts</option>
                <option value="__any__">Any error</option>
                {(facets.errorCodes || []).map((errorCode) => (
                  <option key={errorCode} value={errorCode}>{errorCode}</option>
                ))}
              </FilterSelect>
              <label className="grid gap-1 text-xs text-muted-foreground">
                From
                <Input
                  type="datetime-local"
                  value={draft.startAt}
                  onChange={(event) => updateDraft("startAt", event.target.value)}
                  className="h-9"
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Through
                <Input
                  type="datetime-local"
                  value={draft.endAt}
                  onChange={(event) => updateDraft("endAt", event.target.value)}
                  className="h-9"
                />
              </label>
              <FilterSelect
                label="Rows per page"
                value={draft.pageSize}
                onChange={(value) => updateDraft("pageSize", value)}
              >
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </FilterSelect>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" size="sm" variant="outline" onClick={clear}>
                <X aria-hidden="true" />
                Clear
              </Button>
              <Button type="submit" size="sm" disabled={isPending}>Apply filters</Button>
            </div>
          </div>
        )}
      </form>

      {error && (
        <Alert variant="destructive" className="m-4 flex-shrink-0">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-shrink-0 items-center justify-between border-b px-4 py-2 text-xs text-muted-foreground">
        <span>Showing {firstRow}–{lastRow} of {pageData?.total || 0} matching receipts</span>
        <span className="hidden sm:inline">Raw request values and API keys are never stored here.</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[1050px] border-collapse text-sm">
          <thead className="sticky top-0 z-[1] bg-background text-left text-xs text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]">
            <tr>
              <th className="w-10 px-3 py-2"><span className="sr-only">Details</span></th>
              <th className="px-3 py-2 font-medium">Received</th>
              <th className="px-3 py-2 font-medium">Request / camera</th>
              <th className="px-3 py-2 font-medium">Trigger</th>
              <th className="px-3 py-2 font-medium">Outcome</th>
              <th className="px-3 py-2 font-medium">Resulting reads</th>
              <th className="px-3 py-2 font-medium">Counts</th>
              <th className="px-3 py-2 font-medium">Duration</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((receipt) => {
              const expanded = expandedRows.has(receipt.id);
              const detailsId = `ingress-receipt-${receipt.id}`;
              return (
                <ReceiptRows
                  key={receipt.id}
                  receipt={receipt}
                  expanded={expanded}
                  detailsId={detailsId}
                  onToggle={() => toggleRow(receipt.id)}
                />
              );
            })}
          </tbody>
        </table>
        {!receipts.length && (
          <div className="flex h-full min-h-40 items-center justify-center text-sm text-muted-foreground">
            No ingress receipts found. Adjust the filters or refresh.
          </div>
        )}
      </div>

      <div className="flex flex-shrink-0 items-center justify-between border-t bg-background px-4 py-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isPending || (pageData?.page || 1) <= 1}
          onClick={() => load(applied, pageData.page - 1)}
        >
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          Page {pageData?.page || 1} of {pageData?.totalPages || 1}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isPending || !pageData?.totalPages || pageData.page >= pageData.totalPages}
          onClick={() => load(applied, pageData.page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function ReceiptRows({ receipt, expanded, detailsId, onToggle }) {
  const [copied, setCopied] = useState(false);
  const copyRequestId = async (event) => {
    event.stopPropagation();
    if (!(await copyTextToClipboard(receipt.requestId))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <tr className="border-b border-border/60 align-top hover:bg-muted/20">
        <td className="px-3 py-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={detailsId}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <span className="sr-only">{expanded ? "Hide" : "Show"} receipt details</span>
          </button>
        </td>
        <td className="px-3 py-2 text-xs">{formatTimestamp(receipt.receivedAt)}</td>
        <td className="max-w-72 px-3 py-2">
          <div className="flex items-center gap-1">
            <Link
              href={`/logs?requestId=${encodeURIComponent(receipt.requestId)}&expand=first`}
              className="truncate font-mono text-xs text-blue-500 hover:underline"
              title="Filter operational logs by this request ID"
            >
              {receipt.requestId}
            </Link>
            <button
              type="button"
              onClick={copyRequestId}
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
              title={copied ? "Request ID copied" : "Copy request ID"}
            >
              {copied
                ? <Check className="h-3.5 w-3.5" />
                : <Copy className="h-3.5 w-3.5" />}
              <span className="sr-only">Copy request ID</span>
            </button>
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">{receipt.cameraName || "No camera"}</div>
        </td>
        <td className="px-3 py-2">
          <div>{receipt.triggerType || "—"}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {receipt.triggerField || "No field"} · {receipt.triggerValueState || "unknown"}
            {receipt.triggerAliasConflict ? " · alias conflict" : ""}
          </div>
        </td>
        <td className="px-3 py-2">
          <StatusBadge receipt={receipt} />
          {receipt.errorCode && (
            <div className="mt-1 max-w-52 break-words font-mono text-xs text-red-500">{receipt.errorCode}</div>
          )}
        </td>
        <td className="px-3 py-2">
          {receipt.processedReadIds.length || receipt.duplicateTargetReadIds.length ? (
            <div className="flex flex-wrap gap-1.5">
              {receipt.processedReadIds.map((readId) => (
                <span key={readId} className="inline-flex items-center rounded border border-border bg-muted/30">
                  <Link
                    href={`/live_feed?readId=${encodeURIComponent(readId)}`}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs hover:text-blue-500"
                    title={`Open resulting read ${readId} in Live Feed`}
                  >
                    Read {readId}
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                  <Link
                    href={`/logs?readId=${encodeURIComponent(readId)}&expand=first`}
                    className="border-l border-border p-1.5 text-muted-foreground hover:text-blue-500"
                    title={`View operational logs for read ${readId}`}
                  >
                    <ScrollText className="h-3.5 w-3.5" />
                    <span className="sr-only">View logs for read {readId}</span>
                  </Link>
                </span>
              ))}
              {receipt.duplicateTargetReadIds.map((readId) => (
                <span
                  key={`duplicate-${readId}`}
                  className="inline-flex items-center rounded border border-amber-500/40 bg-amber-500/10"
                >
                  <Link
                    href={`/live_feed?readId=${encodeURIComponent(readId)}`}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs hover:text-amber-500"
                    title={`Open duplicate target read ${readId} in Live Feed`}
                  >
                    Duplicate target {readId}
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                  <Link
                    href={`/logs?readId=${encodeURIComponent(readId)}&expand=first`}
                    className="border-l border-amber-500/30 p-1.5 text-muted-foreground hover:text-amber-500"
                    title={`View operational logs for duplicate target read ${readId}`}
                  >
                    <ScrollText className="h-3.5 w-3.5" />
                    <span className="sr-only">View logs for duplicate target read {readId}</span>
                  </Link>
                </span>
              ))}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">No read created</span>
          )}
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
          {receipt.processedCount} processed<br />
          {receipt.duplicateCount} duplicate · {receipt.ignoredCount} ignored
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-xs">
          {receipt.durationMs == null ? "—" : `${receipt.durationMs} ms`}
        </td>
      </tr>
      {expanded && (
        <tr id={detailsId} className="border-b border-border/60">
          <td colSpan={8} className="px-4 py-3">
            <ReceiptDetails receipt={receipt} />
          </td>
        </tr>
      )}
    </>
  );
}
