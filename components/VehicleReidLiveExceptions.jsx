"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";

import { retryVehicleReidLiveException } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default function VehicleReidLiveExceptions({ initialResult }) {
  const [data, setData] = useState(initialResult?.success ? initialResult.data : null);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(initialResult?.success ? "" : initialResult?.error || "");
  if (!data) return message ? <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{message}</div> : null;
  const retry = async (readId) => {
    setBusy(readId);
    setMessage("");
    try {
      const result = await retryVehicleReidLiveException({ readId });
      if (!result?.success) throw new Error(result?.error || "Unable to retry this item.");
      setData((current) => ({
        ...current,
        overview: result.data.overview,
        exceptions: result.data.exceptions,
      }));
      setMessage(`Read #${readId} was queued for its one bounded operator retry.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold"><AlertTriangle className="h-5 w-5" />Live ReID exceptions</h2>
          <p className="text-sm text-muted-foreground">Conflicts and unavailable evidence remain unassigned. Correct the underlying plate, Vehicle View, or pair review before using the one bounded retry.</p>
        </div>
        <div className="flex gap-2 text-xs">
          <Badge variant="outline">{Number(data.overview?.conflict || 0)} conflicts</Badge>
          <Badge variant="outline">{Number(data.overview?.unavailable || 0)} unavailable</Badge>
          <Badge variant="outline">{Number(data.overview?.failed || 0)} failed</Badge>
        </div>
      </div>
      {data.exceptions.length ? (
        <div className="space-y-2">
          {data.exceptions.map((item) => (
            <div key={item.readId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
              <div>
                <div className="flex flex-wrap items-center gap-2"><Link href={`/live_feed?readId=${item.readId}`} className="font-medium text-blue-500 hover:underline">Read #{item.readId}</Link><Badge variant="secondary">{item.status}</Badge><span>{item.plateNumber || "Unknown plate"}</span></div>
                <p className="mt-1 text-xs text-muted-foreground">{item.cameraName || "Unknown camera"} · {String(item.errorCode || "REID_EVIDENCE_UNAVAILABLE").replaceAll("_", " ").toLowerCase()} · attempt {item.attemptCount} of 3</p>
              </div>
              {data.canRetry && item.operatorRetryCount < 1 ? (
                <Button type="button" size="sm" variant="outline" disabled={busy === item.readId} onClick={() => retry(item.readId)}>
                  {busy === item.readId ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}Retry once
                </Button>
              ) : <span className="text-xs text-muted-foreground">{item.operatorRetryCount >= 1 ? "Operator retry used" : "Maintenance permission required"}</span>}
            </div>
          ))}
        </div>
      ) : <p className="text-sm text-muted-foreground">No live ReID exceptions are waiting for review.</p>}
      {message ? <p role="status" className="text-sm">{message}</p> : null}
    </section>
  );
}
