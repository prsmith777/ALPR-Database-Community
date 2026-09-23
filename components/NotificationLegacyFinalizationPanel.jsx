"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArchiveX, CircleCheckBig, TriangleAlert } from "lucide-react";

import { finalizeLegacyNotificationMigration } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function NotificationLegacyFinalizationPanel({ preview }) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState(null);
  const [isPending, startTransition] = useTransition();

  if (!preview) return null;
  if (preview.rules.length === 0 && preview.finalizedCount > 0) {
    const parts = Object.entries(preview.finalizedCounts || {})
      .map(([type, count]) => `${count} ${type === "mqtt" ? "MQTT" : "Pushover"}`)
      .join(" and ");
    return <Card className="border-emerald-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CircleCheckBig className="h-5 w-5 text-emerald-600" />Legacy notification migration finalized</CardTitle>
        <CardDescription>{parts || preview.finalizedCount} legacy {preview.finalizedCount === 1 ? "rule was" : "rules were"} archived and removed. Unified Notifications rules are the only rule-management system.</CardDescription>
      </CardHeader>
    </Card>;
  }
  if (preview.rules.length === 0) return null;

  function finalize() {
    setMessage(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("confirmation", "finalize_legacy_notification_migration");
      const result = await finalizeLegacyNotificationMigration(formData);
      if (!result.success) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setConfirmed(false);
      setMessage({ kind: "success", text: `Finalized ${result.data.finalizedCount} legacy notification migrations. Their snapshots and audit evidence remain.` });
      router.refresh();
    });
  }

  return <Card>
    <CardHeader>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><ArchiveX className="h-5 w-5" />Finalize legacy notification migration</CardTitle>
          <CardDescription className="mt-1 max-w-3xl">Permanently remove disabled legacy MQTT and Pushover rules after every active unified replacement has produced a successful post-cutover delivery. Credential-free snapshots and audit evidence remain immutable.</CardDescription>
        </div>
        <div className="flex gap-2"><Badge variant="outline">{preview.readyCount} ready</Badge>{preview.blockerCount > 0 && <Badge variant="destructive">{preview.blockerCount} blockers</Badge>}</div>
      </div>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="space-y-2">
        {preview.rules.map((rule) => <div key={rule.migrationId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
          <div><p className="font-medium">{rule.targetName}</p><p className="text-muted-foreground">Legacy {rule.sourceLabel} #{rule.sourceId} → Unified #{rule.targetRuleId}</p></div>
          <Badge variant={rule.blockers.length === 0 ? "outline" : "destructive"}>{rule.blockers.length === 0 ? `Delivery #${rule.successfulDeliveryId} verified` : "Not ready"}</Badge>
        </div>)}
      </div>
      {preview.blockers.length > 0
        ? <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /><ul className="list-disc pl-4">{preview.blockers.map((blocker) => <li key={`${blocker.sourceType}-${blocker.sourceId}-${blocker.message}`}>{blocker.sourceLabel} #{blocker.sourceId}: {blocker.message}</li>)}</ul></div>
        : <div className="space-y-3 rounded-md border p-3">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4" /><span>I understand this permanently removes the legacy MQTT and Pushover rules and their legacy rollback paths. Unified rules and immutable snapshots remain.</span></label>
          <Button type="button" variant="destructive" disabled={!confirmed || isPending || !preview.canFinalize} onClick={finalize}><ArchiveX className="mr-2 h-4 w-4" />{isPending ? "Finalizing..." : `Finalize ${preview.rules.length} legacy ${preview.rules.length === 1 ? "rule" : "rules"}`}</Button>
        </div>}
      {message && <p role="status" className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-emerald-700 dark:text-emerald-300"}>{message.text}</p>}
    </CardContent>
  </Card>;
}
