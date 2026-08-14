"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Check, ChevronDown, Copy, ReceiptText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/browser-clipboard.mjs";

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

function InlineFieldPill({ children, fieldKey, onReveal }) {
  if (!children || !fieldKey) return null;
  return (
    <button
      type="button"
      className="max-w-80 shrink-0 truncate rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onReveal(fieldKey)}
      aria-label={`Show ${fieldKey} in log details`}
      title={`Show ${fieldKey} in log details`}
    >
      {children}
    </button>
  );
}

function firstDetailKey(details, keys) {
  return keys.find((key) => Object.hasOwn(details || {}, key)) || null;
}

function formattedField(key, value, isLast) {
  const serialized = JSON.stringify(value, null, 2) ?? "null";
  const indented = serialized.replace(/\n/g, "\n  ");
  return `  ${JSON.stringify(key)}: ${indented}${isLast ? "" : ","}`;
}

export default function LogMessage({ log, expanded = false, onExpandedChange }) {
  const [highlightedField, setHighlightedField] = useState(null);
  const [copied, setCopied] = useState(false);
  const detailsId = useId();
  const fieldsId = `${detailsId}-fields`;
  const detailEntries = Object.entries(log.details || {});
  const cameraField = firstDetailKey(log.details, ["cameraName", "camera_name", "camera"]);
  const triggerField = firstDetailKey(log.details, ["triggerType", "trigger_type"]);
  const directionField = firstDetailKey(log.details, [
    "directionLabel",
    "directionStatus",
    "direction_label",
    "direction_status",
  ]);
  const readField = firstDetailKey(log.details, [
    "readId",
    "read_id",
    "processedReadIds",
    "processed_read_ids",
    "duplicateTargetReadIds",
    "duplicate_target_read_ids",
  ]);
  const componentField = firstDetailKey(log.details, ["component"]);
  const requestField = firstDetailKey(log.details, ["requestId", "request_id"]);
  const directionErrorField = firstDetailKey(log.details, [
    "directionErrorCode",
    "direction_error_code",
  ]);
  const directionErrorValue = directionErrorField
    ? log.details?.[directionErrorField]
    : null;
  const additionalReadIds = log.readIds?.slice(1) || [];
  const directionContext = log.details?.directionLabel
    ? `Direction ${log.details.directionLabel}`
    : log.details?.directionStatus
      ? `Direction ${log.details.directionStatus}`
      : null;
  const copyRequestId = async () => {
    if (!log.requestId || !(await copyTextToClipboard(log.requestId))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const revealField = (fieldKey) => {
    onExpandedChange?.(log.id, true);
    setHighlightedField(fieldKey);
  };

  useEffect(() => {
    if (!expanded || !highlightedField) return undefined;
    const fieldIndex = Object.keys(log.details || {}).indexOf(highlightedField);
    if (fieldIndex < 0) return undefined;
    const timer = window.setTimeout(() => {
      const target = document.getElementById(`${fieldsId}-field-${fieldIndex}`);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [expanded, fieldsId, highlightedField, log.details]);

  return (
    <article className="border-b border-border/40 py-1.5 last:border-b-0">
      <div className="grid items-center gap-1 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 items-center gap-2 font-mono text-sm leading-6">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 overflow-hidden text-left"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => onExpandedChange?.(log.id, !expanded)}
          >
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
              aria-hidden="true"
            />
            <span className={`shrink-0 ${levelColor(log.level)}`}>
              [{log.level}]
            </span>
            <span className="min-w-0 truncate text-foreground">{log.message}</span>
          </button>
          <div className="ml-1 hidden min-w-0 flex-1 items-center gap-1 overflow-hidden lg:flex">
            <InlineFieldPill fieldKey={cameraField} onReveal={revealField}>
              {log.cameraName}
            </InlineFieldPill>
            <InlineFieldPill fieldKey={triggerField} onReveal={revealField}>
              {log.details?.triggerType ? `Trigger ${log.details.triggerType}` : null}
            </InlineFieldPill>
            <InlineFieldPill fieldKey={directionField} onReveal={revealField}>
              {directionContext}
            </InlineFieldPill>
            {log.readIds?.[0] && (
              <InlineFieldPill fieldKey={readField} onReveal={revealField}>
                Read {log.readIds[0]}
              </InlineFieldPill>
            )}
            {log.readIds?.length > 1 && (
              <InlineFieldPill fieldKey={readField} onReveal={revealField}>
                +{log.readIds.length - 1} reads
              </InlineFieldPill>
            )}
          </div>
        </div>

        <div className="flex items-start justify-between gap-2 lg:justify-end">
          <time className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
            {formattedTimestamp(log.timestamp)}
          </time>
          {log.requestId && (
            <div className="flex items-center gap-0.5">
              {log.component === "plate-read-ingress" && (
                <Button
                  asChild
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                >
                  <Link
                    href={`/logs/receipts?requestId=${encodeURIComponent(log.requestId)}&expand=first`}
                    aria-label="Open matching ingress receipt"
                    title="Open matching ingress receipt"
                  >
                    <ReceiptText aria-hidden="true" />
                  </Link>
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={copyRequestId}
                aria-label="Copy request ID"
                title={copied ? "Request ID copied" : "Copy request ID"}
              >
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              </Button>
            </div>
          )}
        </div>
      </div>

      {expanded && (
        <div
          id={detailsId}
          className="ml-6 mt-2 rounded-md border border-border bg-muted/20 p-3"
        >
          <div className="mb-2 flex flex-wrap items-center gap-1.5 font-mono">
            <InlineFieldPill fieldKey={componentField} onReveal={revealField}>
              {log.component}
            </InlineFieldPill>
            <InlineFieldPill fieldKey={requestField} onReveal={revealField}>
              {log.requestId ? `Request ${log.requestId}` : null}
            </InlineFieldPill>
            <InlineFieldPill fieldKey={directionErrorField} onReveal={revealField}>
              {directionErrorValue
                ? `Direction error ${directionErrorValue}`
                : null}
            </InlineFieldPill>
            {additionalReadIds.map((readId) => (
              <InlineFieldPill
                key={readId}
                fieldKey={readField}
                onReveal={revealField}
              >
                Read {readId}
              </InlineFieldPill>
            ))}
          </div>
          <pre
            id={fieldsId}
            className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground"
          >
            <span className="block">{"{"}</span>
            {detailEntries.map(([key, value], index) => (
              <span
                key={key}
                id={`${fieldsId}-field-${index}`}
                tabIndex={-1}
                className={`block rounded-sm px-1 outline-none transition-colors ${
                  highlightedField === key
                    ? "bg-primary/15 ring-1 ring-inset ring-primary/40"
                    : ""
                }`}
              >
                {formattedField(key, value, index === detailEntries.length - 1)}
              </span>
            ))}
            <span className="block">{"}"}</span>
          </pre>
        </div>
      )}
    </article>
  );
}
