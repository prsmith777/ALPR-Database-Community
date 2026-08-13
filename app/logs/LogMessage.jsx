"use client";

import { useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

function levelColor(level) {
  switch (level) {
    case "ERROR":
      return "text-[#F31260]";
    case "WARN":
      return "text-[#F5A524]";
    case "DEBUG":
      return "text-sky-500";
    default:
      return "text-[#17C964]";
  }
}

function formattedTimestamp(timestamp) {
  if (!timestamp) return "Time unavailable";
  const value = new Date(timestamp);
  return Number.isNaN(value.getTime()) ? "Time unavailable" : value.toLocaleString();
}

function ContextPill({ children }) {
  if (!children) return null;
  return (
    <span className="max-w-80 truncate rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground">
      {children}
    </span>
  );
}

export default function LogMessage({ log }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const detailCount = Object.keys(log.details || {}).length;

  const copyRequestId = async () => {
    if (!log.requestId || !navigator.clipboard) return;
    await navigator.clipboard.writeText(log.requestId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <article className="border-b border-border/40 py-2 last:border-b-0">
      <div className="grid gap-1.5 lg:grid-cols-[minmax(0,1fr)_auto]">
        <button
          type="button"
          className="min-w-0 text-left"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <div className="flex min-w-0 items-start gap-2 font-mono text-sm">
            <ChevronDown
              className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
              aria-hidden="true"
            />
            <span className={`shrink-0 ${levelColor(log.level)}`}>
              [{log.level}]
            </span>
            <span className="break-words text-foreground">{log.message}</span>
          </div>
          <div className="ml-6 mt-1 flex max-h-5 flex-wrap gap-1.5 overflow-hidden">
            <ContextPill>{log.component}</ContextPill>
            <ContextPill>{log.cameraName}</ContextPill>
            <ContextPill>
              {log.details?.triggerType ? `Trigger ${log.details.triggerType}` : null}
            </ContextPill>
            <ContextPill>
              {log.details?.directionLabel
                ? `Direction ${log.details.directionLabel}`
                : log.details?.directionStatus
                  ? `Direction ${log.details.directionStatus}`
                  : null}
            </ContextPill>
            <ContextPill>
              {log.details?.directionErrorCode
                ? `Direction error ${log.details.directionErrorCode}`
                : null}
            </ContextPill>
            {log.readIds?.map((readId) => (
              <ContextPill key={readId}>Read {readId}</ContextPill>
            ))}
            {log.requestId && <ContextPill>Request {log.requestId}</ContextPill>}
          </div>
        </button>

        <div className="flex items-start justify-between gap-2 lg:justify-end">
          <time className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
            {formattedTimestamp(log.timestamp)}
          </time>
          {log.requestId && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={copyRequestId}
              aria-label="Copy request ID"
              title="Copy request ID"
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="ml-6 mt-3 rounded-md border border-border bg-muted/20 p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            Structured fields ({detailCount})
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">
            {JSON.stringify(log.details || {}, null, 2)}
          </pre>
        </div>
      )}
    </article>
  );
}
