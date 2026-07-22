"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const numberFormatter = new Intl.NumberFormat();

function formatResetTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function PushoverUsageCard() {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const loadUsage = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch("/api/notifications/pushover/usage", {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || "Unable to load Pushover usage");
      }
      setUsage(result.data);
    } catch (requestError) {
      setUsage(null);
      setError(String(requestError?.message ?? "Unable to load Pushover usage"));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  const percentUsed = Math.max(0, Math.min(100, Number(usage?.percentUsed) || 0));

  return (
    <Card className="max-w-4xl">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Monthly message allowance</CardTitle>
            <CardDescription className="mt-1">
              Pushover reports this quota across all applications on the account.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={loadUsage}
            disabled={isLoading}
          >
            <RefreshCw
              aria-hidden="true"
              className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
            />
            Refresh usage
          </Button>
        </div>
      </CardHeader>
      <CardContent aria-live="polite">
        {isLoading && !usage ? (
          <p className="text-sm text-muted-foreground">Loading Pushover usage…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Sent</p>
                <p className="text-2xl font-semibold">{numberFormatter.format(usage.used)}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Remaining</p>
                <p className="text-2xl font-semibold">{numberFormatter.format(usage.remaining)}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Monthly limit</p>
                <p className="text-2xl font-semibold">{numberFormatter.format(usage.limit)}</p>
              </div>
            </div>
            <div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${percentUsed}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>{percentUsed.toFixed(1)}% used</span>
                <span>Resets {formatResetTime(usage.resetAt)}</span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
