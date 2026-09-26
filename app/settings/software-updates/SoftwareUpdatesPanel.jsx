"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  CheckCircle2,
  DownloadCloud,
  Loader2,
  RefreshCw,
  RotateCcw,
  ServerCog,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { requestSoftwareUpdate } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { confirmationForCommunityUpdate } from "@/lib/community-update-shape.mjs";
import {
  availableReleaseLabel,
  shouldReloadForRunningRelease,
  softwareUpdateReloadUrl,
} from "@/lib/software-update-browser.mjs";

const MANUAL_CHECKS = Object.freeze([
  "I signed in successfully.",
  "Dashboard and database search work.",
  "A test plate read was ingested.",
  "Plate and vehicle images display.",
  "ALPR remained healthy after a restart.",
]);

const COMMUNITY_RELEASE_BASE_URL = "https://github.com/prsmith777/ALPR-Database-Community/releases/tag/";
const COMMUNITY_UPDATE_GUIDE_URL = "https://github.com/prsmith777/ALPR-Database-Community/blob/main/docs/UPDATES.md";

const ROLLBACK_STATES = new Set([
  "applying",
  "apply-failed",
  "validating",
  "validation-failed",
  "ready-for-acceptance",
  "accepted",
  "rolling-back",
  "rollback-failed",
]);

function formatDate(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

function StatusBadge({ snapshot }) {
  if (!snapshot.agent.online) {
    return <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">Agent offline</span>;
  }
  if (snapshot.busy) {
    return <span className="rounded-full bg-blue-500/15 px-2.5 py-1 text-xs font-medium text-blue-700 dark:text-blue-300">Operation in progress</span>;
  }
  return <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">Ready</span>;
}

function ConfirmationAction({ title, description, operation, target = null, buttonLabel, variant = "default", disabled, onSubmit }) {
  const phrase = confirmationForCommunityUpdate(operation, target);
  const [value, setValue] = useState("");
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <label className="block text-xs font-medium text-muted-foreground">
        Type <code className="select-all font-mono text-foreground">{phrase}</code> to continue.
      </label>
      <Input value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" spellCheck={false} />
      <Button
        type="button"
        variant={variant}
        disabled={disabled || value !== phrase}
        onClick={() => {
          onSubmit({ operation, target, confirmation: value });
          setValue("");
        }}
      >
        {operation === "rollback" ? <RotateCcw /> : operation === "cleanup" ? <Trash2 /> : <DownloadCloud />}
        {buttonLabel}
      </Button>
    </div>
  );
}

export default function SoftwareUpdatesPanel({ initialSnapshot, release }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [error, setError] = useState(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [manualChecks, setManualChecks] = useState(() => MANUAL_CHECKS.map(() => false));
  const [pending, startTransition] = useTransition();
  const reloadingForRelease = useRef(false);

  const refresh = useCallback(async () => {
    if (reloadingForRelease.current) return;
    try {
      const response = await fetch("/api/software-updates/status", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Software update status request failed");
      const result = await response.json();
      if (!result?.success || !result.snapshot) throw new Error("Software update status response is invalid");

      if (shouldReloadForRunningRelease(release.version, result.release?.version)) {
        reloadingForRelease.current = true;
        window.location.replace(softwareUpdateReloadUrl(window.location.href, result.release.version));
        return;
      }

      setSnapshot(result.snapshot);
      setReconnecting(false);
    } catch {
      setReconnecting(true);
    }
  }, [release.version]);

  useEffect(() => {
    const timer = window.setInterval(refresh, 4_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const submit = useCallback((input) => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await requestSoftwareUpdate(input);
        if (!result.success) setError(result.error);
        await refresh();
      } catch {
        setReconnecting(true);
      }
    });
  }, [refresh]);

  const state = snapshot.state;
  const target = state?.targetTag || null;
  const available = availableReleaseLabel(state);
  const releaseTag = target || state?.currentTag || `v${release.version}`;
  const lastCheckedAt = state?.operation === "check" && state?.completedAt
    ? state.completedAt
    : null;
  const disabled = pending || snapshot.busy || !snapshot.agent.online;
  const updateAvailable = state?.operation === "check" && state?.phase === "succeeded" && Boolean(target);
  const canAccept = state?.updaterStatus === "ready-for-acceptance";
  const canValidate = ["validating", "validation-failed", "ready-for-acceptance"].includes(state?.updaterStatus);
  const canRollback = state?.rollbackPresent && ROLLBACK_STATES.has(state?.updaterStatus);
  const canCleanup = state?.rollbackPresent && (state?.updaterStatus === "accepted" || state?.updaterStatus === "rolled-back");
  const checksComplete = useMemo(() => manualChecks.every(Boolean), [manualChecks]);
  const acceptDisabledReason = !snapshot.agent.online
    ? "The host update agent is offline. Start it before accepting the update."
    : snapshot.busy || pending
      ? "Wait for the current update operation to finish."
      : !checksComplete
        ? "Select all five checks before accepting the update."
        : null;

  return (
    <div className="max-w-5xl space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2"><ServerCog className="h-5 w-5" /> Update service</CardTitle>
            <StatusBadge snapshot={snapshot} />
          </div>
          <CardDescription>
            The web application can request only fixed update operations. A restricted worker on the Linux host owns Git, Docker, backups, migrations, and service restarts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Installed</p><p className="mt-1 font-mono font-semibold">v{release.version}</p></div>
            <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Latest stable</p><p className="mt-1 font-mono font-semibold">{available}</p></div>
            <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Last checked</p><p className="mt-1 text-sm font-medium">{formatDate(lastCheckedAt)}</p></div>
            <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Agent last seen</p><p className="mt-1 text-sm font-medium">{formatDate(snapshot.agent.lastSeenAt)}</p></div>
          </div>
          <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            <p>Updates run only when an administrator starts them. Checking for updates does not install or restart anything.</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              <a className="font-medium text-primary underline-offset-4 hover:underline" href={`${COMMUNITY_RELEASE_BASE_URL}${releaseTag}`} target="_blank" rel="noreferrer">View {releaseTag} release notes</a>
              <a className="font-medium text-primary underline-offset-4 hover:underline" href={COMMUNITY_UPDATE_GUIDE_URL} target="_blank" rel="noreferrer">Open the Community update guide</a>
            </div>
          </div>
          {!snapshot.agent.online ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
              <p className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-200"><TriangleAlert className="h-4 w-4" /> Host update agent is not running</p>
              <p className="mt-2 text-muted-foreground">On the ALPR host, run <code className="font-mono">./alpr-community agent install</code>. For unattended startup after reboot, enable lingering as described in the update guide.</p>
            </div>
          ) : null}
          {reconnecting ? (
            <div className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-700 dark:text-blue-300">ALPR may be restarting. This page will reconnect automatically.</div>
          ) : null}
          <Button type="button" variant="outline" disabled={disabled} onClick={() => submit({ operation: "check" })}>
            {pending || snapshot.busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Check for updates
          </Button>
        </CardContent>
      </Card>

      {state ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Latest operation</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-start gap-2">
              {state.phase === "failed" ? <TriangleAlert className="mt-0.5 h-4 w-4 text-destructive" /> : state.phase === "succeeded" ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" /> : <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-blue-600" />}
              <div><p className="font-medium capitalize">{state.operation || "Update"}: {state.phase}</p><p className="mt-1 text-muted-foreground">{state.message}</p></div>
            </div>
            {state.completedAt ? <p className="text-xs text-muted-foreground">Completed {formatDate(state.completedAt)}</p> : null}
          </CardContent>
        </Card>
      ) : null}

      {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div> : null}

      {canValidate ? (
        <Card>
          <CardHeader><CardTitle>Automated validation</CardTitle><CardDescription>Repeat database readiness, exact-image, health, row-count, and storage-inventory checks without accepting the release.</CardDescription></CardHeader>
          <CardContent><Button type="button" variant="outline" disabled={disabled} onClick={() => submit({ operation: "validate" })}><ShieldCheck /> Run validation again</Button></CardContent>
        </Card>
      ) : null}

      {updateAvailable ? (
        <Card>
          <CardHeader><CardTitle>Install {target}</CardTitle><CardDescription>A verified database/configuration backup is created before the exact tagged image is built, installed, restarted, and validated. After acceptance, one rollback generation is retained for the configured retention period.</CardDescription></CardHeader>
          <CardContent>
            <ConfirmationAction title="Install available update" description="ALPR will be briefly unavailable while the host backs up, migrates, restarts, and validates it." operation="update" target={target} buttonLabel={`Install ${target}`} disabled={disabled} onSubmit={submit} />
          </CardContent>
        </Card>
      ) : null}

      {canAccept ? (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" /> Accept or roll back</CardTitle><CardDescription>Automated validation passed. Confirm these real-use checks before accepting the release.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              {MANUAL_CHECKS.map((label, index) => (
                <label key={label} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={manualChecks[index]} onChange={(event) => setManualChecks((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.checked : value))} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <Button type="button" disabled={Boolean(acceptDisabledReason)} onClick={() => submit({ operation: "accept", confirmation: confirmationForCommunityUpdate("accept") })}><CheckCircle2 /> Accept update</Button>
            {acceptDisabledReason ? <p role="status" className="text-sm text-muted-foreground">{acceptDisabledReason}</p> : null}
          </CardContent>
        </Card>
      ) : null}

      {canRollback ? (
        <Card className="border-amber-500/40">
          <CardHeader><CardTitle>Rollback</CardTitle><CardDescription>Restore the pre-update database, configuration, source release, and application image. Records written after the update snapshot will be discarded.</CardDescription></CardHeader>
          <CardContent><ConfirmationAction title="Restore the previous release" description="Use this if validation or real-use checks reveal a problem." operation="rollback" buttonLabel="Roll back" variant="destructive" disabled={disabled} onSubmit={submit} /></CardContent>
        </Card>
      ) : null}

      {canCleanup ? (
        <Card>
          <CardHeader><CardTitle>Rollback storage</CardTitle><CardDescription>{state.rollbackEligibleUntil ? `The one-generation rollback copy is retained until ${formatDate(state.rollbackEligibleUntil)}.` : "Remove a rollback copy only when its retention window has ended."}</CardDescription></CardHeader>
          <CardContent><ConfirmationAction title="Remove retained rollback copy" description="The host enforces the retention deadline and removes only updater-owned artifacts." operation="cleanup" buttonLabel="Remove rollback copy" variant="outline" disabled={disabled} onSubmit={submit} /></CardContent>
        </Card>
      ) : null}
    </div>
  );
}
