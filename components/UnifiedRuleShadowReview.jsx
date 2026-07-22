import { GitCompareArrows, ShieldCheck, TriangleAlert } from "lucide-react";

import { ApproveShadowReviewButton } from "@/components/ApproveShadowReviewButton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function status(rule) {
  if (rule.status === "approved") return { label: "Approved", variant: "default" };
  if (rule.status === "ready") return { label: "Ready for approval", variant: "outline" };
  if (rule.status === "no_samples") return { label: "Waiting for reads", variant: "secondary" };
  if (rule.status === "no_positive_matches") return { label: "Waiting for a matching read", variant: "secondary" };
  if (rule.status === "unsafe") return { label: "Safety check failed", variant: "destructive" };
  return { label: "Mismatch found", variant: "destructive" };
}

function decisionBadge(matched) {
  return <Badge variant={matched ? "default" : "outline"}>{matched ? "Match" : "No match"}</Badge>;
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function RuleReview({ rule }) {
  const state = status(rule);
  const canApprove =
    rule.status === "ready" &&
    rule.sampleCount > 0 &&
    rule.mismatchCount === 0 &&
    rule.positiveMatchCount > 0;
  const visibleDecisions = rule.decisions.slice(0, 10);

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{rule.sourceType.toUpperCase()} #{rule.sourceId}</Badge>
            <span className="font-medium">{rule.sourceName}</span>
            <span className="text-muted-foreground">→</span>
            <span className="font-medium">Unified #{rule.targetRule.id}</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{rule.targetRule.name}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={rule.sourceEnabled ? "default" : "outline"}>
            Legacy {rule.sourceEnabled ? "active" : "inactive"}
          </Badge>
          <Badge variant="secondary">Unified disabled</Badge>
          <Badge variant={state.variant}>{state.label}</Badge>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-md border p-3"><p className="text-xs uppercase text-muted-foreground">Relevant reads</p><p className="text-xl font-semibold">{rule.sampleCount}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs uppercase text-muted-foreground">Agreements</p><p className="text-xl font-semibold">{rule.agreementCount}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs uppercase text-muted-foreground">Positive matches</p><p className="text-xl font-semibold">{rule.positiveMatchCount}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs uppercase text-muted-foreground">Mismatches</p><p className="text-xl font-semibold">{rule.mismatchCount}</p></div>
      </div>

      {rule.status === "no_positive_matches" && (
        <div className="rounded-md border p-3 text-sm text-muted-foreground">
          Negative comparisons agree, but approval stays locked until this rule sees at least one read that both legacy and unified logic match.
        </div>
      )}

      {!rule.allDisabled && (
        <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          The unified rule, channel, and actions must all be disabled before review.
        </div>
      )}

      {rule.latestReview && (
        <div className={`rounded-md border p-3 text-sm ${rule.latestReview.current ? "border-emerald-500/40 bg-emerald-500/5" : ""}`}>
          <p className="font-medium">{rule.latestReview.current ? "Current evidence approved" : "Earlier evidence approval is stale"}</p>
          <p className="mt-1 text-muted-foreground">
            {rule.latestReview.reviewerName} reviewed {rule.latestReview.sampleCount} reads on {formatTimestamp(rule.latestReview.reviewedAt)}.
          </p>
        </div>
      )}

      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Inspect comparison evidence ({Math.min(visibleDecisions.length, 10)} shown)
        </summary>
        {visibleDecisions.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No relevant recent reads are available yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead><tr className="border-b"><th className="p-2">Read</th><th className="p-2">Camera</th><th className="p-2">Legacy</th><th className="p-2">Unified</th><th className="p-2">Result</th></tr></thead>
              <tbody>
                {visibleDecisions.map((decision) => (
                  <tr key={decision.readId} className="border-b last:border-0">
                    <td className="p-2"><p className="font-medium">{decision.observedPlate}</p><p className="text-xs text-muted-foreground">{formatTimestamp(decision.timestamp)}</p></td>
                    <td className="p-2">{decision.cameraName}</td>
                    <td className="p-2">{decisionBadge(decision.legacyMatched)}<p className="mt-1 text-xs text-muted-foreground">{decision.legacyReason}</p></td>
                    <td className="p-2">{decisionBadge(decision.unifiedMatched)}<p className="mt-1 text-xs text-muted-foreground">{decision.unifiedReason}</p></td>
                    <td className="p-2">{decision.agreement ? <span className="text-emerald-700 dark:text-emerald-300">Agreement</span> : <span className="text-destructive">Mismatch</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>

      {rule.status !== "approved" && (
        <ApproveShadowReviewButton ruleId={rule.targetRule.id} disabled={!canApprove} />
      )}
    </div>
  );
}

export function UnifiedRuleShadowReview({ review }) {
  if (!review) {
    return (
      <Card><CardHeader><CardTitle>Unified rule shadow review</CardTitle><CardDescription>The shadow comparison could not be loaded.</CardDescription></CardHeader></Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><GitCompareArrows className="h-5 w-5" aria-hidden="true" />Unified rule shadow review</CardTitle>
            <CardDescription className="mt-1 max-w-3xl">
              Compare each disabled unified copy with its legacy rule over recent reads. Evaluation happens in memory: it writes no executions, publishes no messages, and attempts no delivery.
            </CardDescription>
          </div>
          <div className="flex gap-2"><Badge variant="outline">Read only</Badge><Badge variant="outline">No delivery</Badge></div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-md border p-3"><p className="text-xs uppercase text-muted-foreground">Rules</p><p className="text-2xl font-semibold">{review.ruleCount}</p></div>
          <div className="rounded-md border p-3"><p className="text-xs uppercase text-muted-foreground">Recent reads</p><p className="text-2xl font-semibold">{review.evaluatedReadCount}</p></div>
          <div className="rounded-md border p-3"><p className="text-xs uppercase text-muted-foreground">Agreements</p><p className="text-2xl font-semibold">{review.agreementCount}</p></div>
          <div className="rounded-md border p-3"><p className="text-xs uppercase text-muted-foreground">Mismatches</p><p className="text-2xl font-semibold">{review.mismatchCount}</p></div>
        </div>
        <div className="flex gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
          <span><strong>Safety invariant:</strong> {review.deliveryAttempts} delivery attempts. Approval records evidence only; cutover remains a separate step.</span>
        </div>
        {review.rules.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">Create disabled unified copies before running a shadow review.</p>
        ) : (
          <div className="space-y-4">{review.rules.map((rule) => <RuleReview key={`${rule.sourceType}-${rule.sourceId}`} rule={rule} />)}</div>
        )}
      </CardContent>
    </Card>
  );
}

export const unifiedRuleShadowReviewUiInternals = Object.freeze({ formatTimestamp, status });
