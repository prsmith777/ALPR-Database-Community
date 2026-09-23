"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Archive, ArrowLeftRight, RotateCcw, ShieldCheck } from "lucide-react";

import {
  cutoverUnifiedNotificationRule,
  retireOrphanedUnifiedNotificationRule,
  rollbackUnifiedNotificationRule,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function RuleCutover({ rule }) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState(null);
  const [isPending, startTransition] = useTransition();
  const active = rule.state === "unified_active";
  const orphaned = rule.canRetire === true;

  function submit() {
    setMessage(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("ruleId", String(rule.targetRuleId));
      formData.set(
        "confirmation",
        orphaned
          ? "retire_orphaned_migration"
          : active
            ? "rollback_one_rule"
            : "cutover_one_rule"
      );
      const result = orphaned
        ? await retireOrphanedUnifiedNotificationRule(formData)
        : active
          ? await rollbackUnifiedNotificationRule(formData)
          : await cutoverUnifiedNotificationRule(formData);
      if (!result.success) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setConfirmed(false);
      setMessage({
        kind: "success",
        text: orphaned
          ? "Migration retired. Its unified rule and audit evidence remain stored and disabled."
          : active
            ? "Rollback recorded. Legacy delivery is active and unified delivery is disabled."
            : "Cutover recorded. Unified delivery is active and legacy delivery is disabled.",
      });
      router.refresh();
    });
  }

  const allowed = orphaned || (active ? rule.canRollback : rule.canCutover);
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{rule.targetName}</p>
          <p className="text-sm text-muted-foreground">
            {rule.sourceType.toUpperCase()} #{rule.sourceId} -&gt; Unified #{rule.targetRuleId}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={rule.sourceEnabled ? "default" : "outline"}>
            Legacy {rule.state === "source_removed" ? "removed" : rule.sourceEnabled ? "active" : "disabled"}
          </Badge>
          <Badge variant={rule.targetEnabled ? "default" : "secondary"}>
            Unified {rule.targetEnabled ? "active" : "disabled"}
          </Badge>
          {rule.approved && (
            <Badge variant="outline">
              {rule.approvalMode === "intentional_expansion" ? "Expansion approved" : "Evidence approved"}
            </Badge>
          )}
        </div>
      </div>

      {rule.blockers.length > 0 && !active && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {rule.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
        </ul>
      )}

      {allowed && (
        <div className="space-y-3 rounded-md border p-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              {orphaned
                ? "I understand retirement removes this safely disabled copy from active migration workflows without deleting its rule, configuration, or audit evidence."
                : active
                  ? "I understand rollback disables this unified rule and atomically restores its legacy rule."
                : rule.approvalMode === "intentional_expansion"
                  ? "I approve this intentional expansion and cutting over this one rule; legacy delivery will be disabled atomically before broader unified delivery becomes active."
                  : "I approve cutting over this one rule; legacy delivery will be disabled atomically before unified delivery becomes active."}
            </span>
          </label>
          <Button type="button" disabled={!confirmed || isPending} onClick={submit}>
            {orphaned
              ? <Archive className="mr-2 h-4 w-4" aria-hidden="true" />
              : active
                ? <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                : <ArrowLeftRight className="mr-2 h-4 w-4" aria-hidden="true" />}
            {isPending
              ? orphaned
                ? "Retiring..."
                : active
                  ? "Rolling back..."
                  : "Cutting over..."
              : orphaned
                ? "Retire orphaned migration"
                : active
                  ? "Roll back this rule"
                  : "Cut over this rule"}
          </Button>
        </div>
      )}

      {message && (
        <p role="status" className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-emerald-700 dark:text-emerald-300"}>
          {message.text}
        </p>
      )}
    </div>
  );
}

export function NotificationCutoverPanel({ preview }) {
  if (!preview) {
    return (
      <Card><CardHeader><CardTitle>Guarded unified-rule cutover</CardTitle><CardDescription>Cutover readiness could not be loaded.</CardDescription></CardHeader></Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" aria-hidden="true" />Guarded unified-rule cutover</CardTitle>
            <CardDescription className="mt-1 max-w-3xl">
              Switch one approved rule at a time. The legacy source and unified target change in one transaction, and every active unified rule exposes an immediate rollback.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2"><Badge variant="outline">{preview.eligibleCount} eligible</Badge><Badge variant="outline">{preview.activeCount} active</Badge><Badge variant="outline">{preview.orphanedCount || 0} orphaned</Badge></div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {preview.rules.length === 0
          ? <p className="rounded-md border p-4 text-sm text-muted-foreground">Create and review disabled unified copies before cutover.</p>
          : preview.rules.map((rule) => <RuleCutover key={rule.targetRuleId} rule={rule} />)}
      </CardContent>
    </Card>
  );
}
