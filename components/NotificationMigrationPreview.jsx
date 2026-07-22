import { ArrowRight, ShieldCheck } from "lucide-react";

import { ApplyNotificationMigrationButton } from "@/components/ApplyNotificationMigrationButton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function conditionLabel(condition = {}) {
  const value = condition.value ?? {};
  if (condition.conditionType === "always") return "Any accepted plate";
  if (condition.conditionType === "plate_match") {
    const mode = value.mode && value.mode !== "off" ? ` (${value.mode})` : "";
    return `Plate ${value.plate || "(missing)"}${mode}`;
  }
  if (condition.conditionType === "known_plate") return "Any known plate";
  if (condition.conditionType === "known_name") {
    return `Known name: ${(value.names || []).join(", ")}`;
  }
  if (condition.conditionType === "tag") return `Tag: ${(value.tags || []).join(", ")}`;
  if (condition.conditionType === "camera") {
    return `Camera: ${(value.names || []).join(", ")}`;
  }
  return condition.conditionType || "Unknown condition";
}

function actionLabel(action = {}) {
  if (action.channelType === "pushover") {
    return `Pushover priority ${action.configuration?.priority ?? 1}`;
  }
  if (action.channelType === "mqtt") {
    const broker = action.configuration?.brokerName || "unnamed broker";
    const destination =
      action.configuration?.destinationMode === "fixed_topic"
        ? action.configuration?.fixedTopic || "missing topic"
        : "per-camera topic";
    return `MQTT via ${broker} to ${destination}`;
  }
  return action.channelType || "Unknown action";
}

function RulePreview({ rule }) {
  const conditions = rule.proposed.conditionTree?.children ?? [];
  const actions = rule.proposed.actions ?? [];
  const migrated = rule.migration?.status === "created_disabled";

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{rule.source.type.toUpperCase()}</Badge>
            <span className="font-medium">{rule.source.name}</span>
            <Badge variant={rule.source.enabled ? "default" : "outline"}>
              Source {rule.source.enabled ? "active" : "inactive"}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Existing rule <ArrowRight className="mx-1 inline h-3 w-3" aria-hidden="true" />{" "}
            {rule.proposed.name}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={rule.ready ? "outline" : "destructive"}>
            {rule.ready ? "Ready to review" : "Needs attention"}
          </Badge>
          {migrated && (
            <Badge variant="secondary">
              Created disabled rule #{rule.migration.targetRuleId}
            </Badge>
          )}
        </div>
      </div>

      <div className="grid gap-3 text-sm md:grid-cols-2">
        <div>
          <p className="font-medium">Conditions</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            {conditions.map((condition, index) => (
              <li key={`${condition.conditionType}-${index}`}>{conditionLabel(condition)}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-medium">Actions</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            {actions.map((action, index) => (
              <li key={`${action.channelType}-${index}`}>{actionLabel(action)}</li>
            ))}
          </ul>
        </div>
      </div>

      {rule.blockers.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">Resolve before migration</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            {rule.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function NotificationMigrationPreview({ preview }) {
  if (!preview) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Unified rules migration preview</CardTitle>
          <CardDescription>The read-only preview could not be loaded.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
              Unified rules migration preview
            </CardTitle>
            <CardDescription className="mt-1 max-w-3xl">
              Review how existing Pushover and MQTT rules translate into the shared model.
              This preview performs no writes, enables no new rules, and leaves current delivery unchanged.
            </CardDescription>
          </div>
          <Badge variant="outline">Read only</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Pushover</p>
            <p className="text-2xl font-semibold">{preview.sourceCounts.pushover}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">MQTT</p>
            <p className="text-2xl font-semibold">{preview.sourceCounts.mqtt}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Ready</p>
            <p className="text-2xl font-semibold">{preview.readyCount}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Created</p>
            <p className="text-2xl font-semibold">{preview.migratedCount ?? 0}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Pending</p>
            <p className="text-2xl font-semibold">{preview.pendingReadyCount ?? preview.readyCount}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Reconcile</p>
            <p className="text-2xl font-semibold">{preview.reconcileReadyCount ?? 0}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Writes</p>
            <p className="text-2xl font-semibold">{preview.writesPerformed}</p>
          </div>
        </div>

        <ApplyNotificationMigrationButton
          pendingCount={preview.pendingReadyCount ?? preview.readyCount}
          migratedCount={preview.migratedCount ?? 0}
          reconcileCount={preview.reconcileReadyCount ?? 0}
        />

        {preview.rules.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            No existing notification rules are available to preview.
          </p>
        ) : (
          <div className="space-y-3">
            {preview.rules.map((rule) => (
              <RulePreview key={`${rule.source.type}-${rule.source.id}`} rule={rule} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export const notificationMigrationPreviewUiInternals = Object.freeze({
  actionLabel,
  conditionLabel,
});
