"use client";

import { ChevronDown, Clock3 } from "lucide-react";

function formattedTimestamp(timestamp) {
  if (!timestamp) return "Time unavailable";
  const value = new Date(timestamp);
  return Number.isNaN(value.getTime()) ? "Time unavailable" : value.toLocaleString();
}

function readableEventType(value) {
  return String(value || "Pipeline event")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusClass(status) {
  switch (status) {
    case "failed":
      return "border-red-500/40 bg-red-500/10 text-red-400";
    case "partial":
      return "border-amber-500/40 bg-amber-500/10 text-amber-400";
    case "queued":
      return "border-blue-500/40 bg-blue-500/10 text-blue-400";
    case "skipped":
      return "border-border bg-muted/40 text-muted-foreground";
    default:
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-400";
  }
}

function DetailPill({ name, value }) {
  const rendered = typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
  return (
    <span className="rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {name}: {rendered}
    </span>
  );
}

export default function ReadPipelineTimeline({
  timeline,
  expanded = false,
  onExpandedChange,
}) {
  const events = timeline?.events || [];
  const summary = timeline?.error
    ? "Timeline unavailable"
    : events.length
      ? `${timeline.total} durable ${timeline.total === 1 ? "event" : "events"}`
      : timeline?.readExists
        ? "No durable events for this legacy read"
        : "Read not found";

  return (
    <section className="flex-shrink-0 border-b border-border/60 bg-muted/10">
      <button
        type="button"
        className="flex min-h-9 w-full items-center justify-between gap-3 px-4 py-1.5 text-left text-xs"
        aria-expanded={expanded}
        aria-controls="read-pipeline-timeline-details"
        onClick={() => onExpandedChange?.(!expanded)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          />
          <Clock3 className="h-4 w-4 shrink-0 text-blue-400" aria-hidden="true" />
          <span className="font-medium text-foreground">Durable read timeline</span>
          <span className="truncate text-muted-foreground">{summary}</span>
        </span>
        <span className="hidden shrink-0 text-muted-foreground md:inline">
          {expanded ? "Hide timeline" : "Show timeline"}
        </span>
      </button>

      {expanded && (
        <div id="read-pipeline-timeline-details" className="max-h-72 overflow-y-auto border-t px-4 py-2">
          {timeline?.error ? (
            <p className="text-xs text-red-400">{timeline.error}</p>
          ) : events.length ? (
            <ol className="space-y-1.5">
              {events.map((event) => (
                <li key={event.id} className="rounded-md border border-border bg-background/70 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">
                        {readableEventType(event.eventType)}
                      </span>
                      <span className="text-muted-foreground">{event.stage}</span>
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] ${statusClass(event.status)}`}>
                        {event.status}
                      </span>
                    </span>
                    <time className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {formattedTimestamp(event.occurredAt)}
                    </time>
                  </div>
                  {Object.keys(event.details || {}).length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {Object.entries(event.details).map(([name, value]) => (
                        <DetailPill key={name} name={name} value={value} />
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">
              Durable timeline events begin with reads ingested after this release. Existing reads continue to use operational logs and ingress receipts.
            </p>
          )}
          {timeline?.truncated && (
            <p className="mt-2 text-[10px] text-muted-foreground">
              Showing the newest 100 events for this read.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
