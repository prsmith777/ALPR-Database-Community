"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ChevronDown, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { getReadPipelineTimeline, getSystemLogs } from "@/app/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import LogMessage from "./LogMessage";
import ReadPipelineTimeline from "./ReadPipelineTimeline";

const LEVELS = ["ALL", "INFO", "WARN", "ERROR", "DEBUG"];
const LIVE_REFRESH_MS = 5_000;

function defaultFilters(pageSize = 50) {
  return {
    level: "ALL",
    search: "",
    component: "",
    cameraName: "",
    requestId: "",
    readId: "",
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

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function appliedFilterLabels(filters) {
  const labels = [];
  if (filters.level && filters.level !== "ALL") labels.push(filters.level);
  if (filters.search) labels.push(`Search: ${filters.search}`);
  if (filters.requestId) labels.push(`Request: ${filters.requestId}`);
  if (filters.readId) labels.push(`Read: ${filters.readId}`);
  if (filters.component) labels.push(`Component: ${filters.component}`);
  if (filters.cameraName) labels.push(`Camera: ${filters.cameraName}`);
  if (filters.startAt) labels.push(`From: ${filters.startAt}`);
  if (filters.endAt) labels.push(`Through: ${filters.endAt}`);
  return labels;
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

export default function LogViewer({
  initialPage,
  initialFilters: requestedFilters = {},
  initialExpandFirst = false,
  initialTimeline = null,
}) {
  const initialFilters = {
    ...defaultFilters(initialPage?.pageSize),
    ...requestedFilters,
  };
  const [pageData, setPageData] = useState(initialPage);
  const [draft, setDraft] = useState(initialFilters);
  const [applied, setApplied] = useState(initialFilters);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [liveUpdates, setLiveUpdates] = useState(true);
  const [timelineData, setTimelineData] = useState(initialTimeline);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [expandedRows, setExpandedRows] = useState(() => {
    const firstLogId = initialExpandFirst ? initialPage?.entries?.[0]?.id : null;
    return new Set(firstLogId ? [firstLogId] : []);
  });
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();
  const requestInFlight = useRef(false);

  const updateDraft = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const load = useCallback((filters, page = 1) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    startTransition(async () => {
      try {
        setError("");
        const [response, timelineResponse] = await Promise.all([
          getSystemLogs(actionFilters(filters, page)),
          filters.readId
            ? getReadPipelineTimeline(filters.readId)
            : Promise.resolve(null),
        ]);
        if (!response?.success) {
          setError(response?.error || "Failed to load system logs");
          return;
        }
        setPageData(response.data);
        setApplied(filters);
        setTimelineData(
          filters.readId
            ? timelineResponse?.success
              ? timelineResponse.data
              : {
                  readId: Number(filters.readId),
                  readExists: false,
                  total: 0,
                  events: [],
                  error:
                    timelineResponse?.error ||
                    "Failed to read the plate-read pipeline timeline",
                }
            : null
        );
        if (!filters.readId) setTimelineExpanded(false);
        const visibleIds = new Set(
          (response.data?.entries || []).map((entry) => entry.id)
        );
        setExpandedRows((current) => {
          const next = new Set(
            [...current].filter((logId) => visibleIds.has(logId))
          );
          return next.size === current.size ? current : next;
        });
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load system logs"
        );
      } finally {
        requestInFlight.current = false;
      }
    });
  }, []);

  const apply = (event) => {
    event?.preventDefault();
    setFiltersExpanded(false);
    load(draft, 1);
  };

  const selectLevel = (level) => {
    const next = { ...draft, level };
    setDraft(next);
    setFiltersExpanded(false);
    load(next, 1);
  };

  const clear = () => {
    const next = defaultFilters(pageData?.pageSize);
    setDraft(next);
    setFiltersExpanded(false);
    setTimelineExpanded(false);
    load(next, 1);
    if (window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  };

  const clearReadFilter = () => {
    const next = { ...applied, readId: "" };
    setDraft((current) => ({ ...current, readId: "" }));
    setTimelineExpanded(false);
    load(next, 1);
    window.history.replaceState(null, "", window.location.pathname);
  };

  const metadata = pageData?.metadata || {};
  const entries = pageData?.entries || [];
  const firstRow = pageData?.total
    ? (pageData.page - 1) * pageData.pageSize + 1
    : 0;
  const lastRow = Math.min(pageData?.total || 0, pageData?.page * pageData?.pageSize);
  const activeLabels = appliedFilterLabels(applied);
  const hasUnappliedChanges = Object.keys(draft).some(
    (field) => draft[field] !== applied[field]
  );
  const hasExpandedRows = expandedRows.size > 0;
  const liveUpdatesActive =
    liveUpdates && pageData?.page === 1 && !hasExpandedRows && !timelineExpanded;
  const updateExpandedRow = useCallback((logId, expanded) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (expanded) next.add(logId);
      else next.delete(logId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!liveUpdatesActive) return undefined;

    const refreshVisiblePage = () => {
      if (document.visibilityState === "visible") load(applied, 1);
    };
    const timer = window.setInterval(refreshVisiblePage, LIVE_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshVisiblePage);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisiblePage);
    };
  }, [applied, liveUpdatesActive, load]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form onSubmit={apply} className="flex-shrink-0 border-b bg-background">
        <div className="flex min-h-12 flex-wrap items-center gap-2 px-4 py-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={filtersExpanded}
            aria-controls="system-log-filters"
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
              className={`transition-transform ${filtersExpanded ? "rotate-180" : ""}`}
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
              <span>All levels · all sources</span>
            )}
            {hasUnappliedChanges && (
              <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-500">
                Unapplied changes
              </span>
            )}
          </div>

          <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:inline">
            {metadata.availableRows || 0} entries
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={liveUpdates}
            title={
              liveUpdatesActive
                ? "Live updates refresh every 5 seconds"
                : hasExpandedRows
                  ? "Live updates resume when log details are closed"
                : timelineExpanded
                  ? "Live updates resume when the durable timeline is closed"
                : liveUpdates
                  ? "Live updates resume on page 1"
                  : "Live updates are off"
            }
            onClick={() => setLiveUpdates((enabled) => !enabled)}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                liveUpdatesActive
                  ? "bg-emerald-500"
                  : liveUpdates
                    ? "bg-amber-500"
                    : "bg-muted-foreground/50"
              }`}
              aria-hidden="true"
            />
            {liveUpdatesActive ? "Live" : liveUpdates ? "Paused" : "Live off"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => load(applied, pageData?.page || 1)}
            disabled={isPending}
          >
            <RefreshCw className={isPending ? "animate-spin" : ""} aria-hidden="true" />
            Refresh
          </Button>
        </div>

        {filtersExpanded && (
          <div id="system-log-filters" className="border-t px-4 pb-3 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[16rem] flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Search all log fields"
                  placeholder="Search messages and structured fields"
                  value={draft.search}
                  onChange={(event) => updateDraft("search", event.target.value)}
                  className="pl-10"
                />
              </div>
              <Button type="submit" size="sm" disabled={isPending}>
                Apply filters
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={clear}
                disabled={isPending}
              >
                <X aria-hidden="true" /> Clear
              </Button>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
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
                  placeholder="40645"
                  inputMode="numeric"
                  className="h-9"
                />
              </label>
              <FilterSelect
                label="Component"
                value={draft.component}
                onChange={(value) => updateDraft("component", value)}
              >
                <option value="">All components</option>
                {pageData?.facets?.components?.map((component) => (
                  <option key={component} value={component}>{component}</option>
                ))}
              </FilterSelect>
              <FilterSelect
                label="Camera"
                value={draft.cameraName}
                onChange={(value) => updateDraft("cameraName", value)}
              >
                <option value="">All cameras</option>
                {pageData?.facets?.cameras?.map((camera) => (
                  <option key={camera} value={camera}>{camera}</option>
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
                {[25, 50, 100].map((size) => (
                  <option key={size} value={String(size)}>{size}</option>
                ))}
              </FilterSelect>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="grid gap-1 text-xs text-muted-foreground">
                <span>Log level</span>
                <div className="flex h-9 overflow-hidden rounded-md border border-border">
                  {LEVELS.map((level, index) => (
                    <button
                      type="button"
                      key={level}
                      onClick={() => selectLevel(level)}
                      disabled={isPending}
                      className={`px-3 text-sm font-medium transition-colors ${
                        draft.level === level
                          ? "bg-muted/60 text-blue-500"
                          : "text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                      } ${index ? "border-l border-border" : ""}`}
                    >
                      {level === "ALL" ? "All" : level.charAt(0) + level.slice(1).toLowerCase()}
                    </button>
                  ))}
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                Active file {formatBytes(metadata.fileBytes)} / {formatBytes(metadata.maxFileBytes)}
                {metadata.maxFiles ? ` · ${metadata.maxFiles} rotated files configured` : ""}
                {` · ${metadata.availableRows || 0} available rows`}
              </div>
            </div>
          </div>
        )}
      </form>

      {error && (
        <Alert variant="destructive" className="m-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
          {applied.readId && (
            <div className="flex min-w-0 items-center gap-2">
              <span>Read #{applied.readId} pipeline</span>
              <span className="text-muted-foreground/60" aria-hidden="true">·</span>
              <span>
                {timelineData?.total || 0} durable {timelineData?.total === 1 ? "event" : "events"}
              </span>
              <span className="text-muted-foreground/60" aria-hidden="true">·</span>
              <span>
                {pageData?.total || 0} operational {pageData?.total === 1 ? "log" : "logs"}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={clearReadFilter}
                disabled={isPending}
              >
                Show all logs
              </Button>
            </div>
          )}
          <span className={applied.readId ? "hidden" : undefined}>
            {pageData?.total
              ? `Showing ${firstRow}–${lastRow} of ${pageData.total} matching entries`
              : "No matching log entries"}
          </span>
          <span className="hidden md:inline">Newest entries first; select a row for structured fields.</span>
        </div>

        {applied.readId && (
          <ReadPipelineTimeline
            timeline={timelineData}
            expanded={timelineExpanded}
            onExpandedChange={setTimelineExpanded}
          />
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {entries.length ? (
            entries.map((log) => (
              <LogMessage
                key={log.id}
                log={log}
                expanded={expandedRows.has(log.id)}
                onExpandedChange={updateExpandedRow}
              />
            ))
          ) : (
            <div className="flex h-full items-center justify-center py-12 text-muted-foreground">
              No logs found. Adjust the filters or refresh.
            </div>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center justify-between border-t px-4 py-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending || !pageData?.totalPages || pageData.page <= 1}
            onClick={() => load(applied, pageData.page - 1)}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {pageData?.totalPages ? pageData.page : 0} of {pageData?.totalPages || 0}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              isPending || !pageData?.totalPages || pageData.page >= pageData.totalPages
            }
            onClick={() => load(applied, pageData.page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
