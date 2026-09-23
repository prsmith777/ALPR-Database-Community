"use client";

import { FlaskConical, PencilLine, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import {
  simulateDisabledUnifiedNotificationRule,
  updateDisabledUnifiedNotificationRule,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { normalizeEditableTagCameraTree } from "@/lib/notification-rule-draft-shape.mjs";

function editableDraft(rule) {
  const root = rule?.targetRule?.conditionTree;
  const shape = normalizeEditableTagCameraTree(root);
  if (!rule?.allDisabled || !shape) return null;
  return {
    ruleId: rule.targetRule.id,
    name: rule.targetRule.name,
    version: rule.targetRule.version,
    requireKnownPlate: shape.requireKnownPlate,
    tags: shape.tags,
    cameras: shape.cameras,
  };
}

function DraftRule({ draft }) {
  const router = useRouter();
  const [requireKnownPlate, setRequireKnownPlate] = useState(draft.requireKnownPlate);
  const [tags, setTags] = useState(draft.tags.join(", "));
  const [cameras, setCameras] = useState(draft.cameras.join(", "));
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState(null);
  const [plateNumber, setPlateNumber] = useState("TEST123");
  const [cameraName, setCameraName] = useState(draft.cameras[0] || "");
  const [testTags, setTestTags] = useState(draft.tags.join(", "));
  const [knownPlate, setKnownPlate] = useState(false);
  const [simulation, setSimulation] = useState(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setMessage(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("ruleId", String(draft.ruleId));
      formData.set("requireKnownPlate", String(requireKnownPlate));
      formData.set("tags", tags);
      formData.set("cameras", cameras);
      formData.set("confirmation", "save_disabled_rule_draft");
      const result = await updateDisabledUnifiedNotificationRule(formData);
      if (!result.success) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setConfirmed(false);
      setMessage({
        kind: "success",
        text: `Saved version ${result.data.version}. Rule and delivery remain disabled.`,
      });
      router.refresh();
    });
  }

  function simulate() {
    setMessage(null);
    setSimulation(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("ruleId", String(draft.ruleId));
      formData.set("plateNumber", plateNumber);
      formData.set("cameraName", cameraName);
      formData.set("testTags", testTags);
      formData.set("knownPlate", String(knownPlate));
      const result = await simulateDisabledUnifiedNotificationRule(formData);
      if (!result.success) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setSimulation(result.data);
    });
  }

  return (
    <div className="space-y-5 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{draft.name}</p>
          <p className="text-sm text-muted-foreground">Unified #{draft.ruleId}, version {draft.version}</p>
        </div>
        <div className="flex gap-2"><Badge variant="secondary">Disabled</Badge><Badge variant="outline">No delivery</Badge></div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Tags (comma separated)</span>
          <Input value={tags} onChange={(event) => setTags(event.target.value)} disabled={isPending} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Cameras (comma separated)</span>
          <Input value={cameras} onChange={(event) => setCameras(event.target.value)} disabled={isPending} />
        </label>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={requireKnownPlate}
          onChange={(event) => setRequireKnownPlate(event.target.checked)}
          disabled={isPending}
          className="mt-0.5 h-4 w-4"
        />
        <span><strong>Require Known Plate.</strong> Clear this for a true tag-only rule.</span>
      </label>
      <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          disabled={isPending}
          className="mt-0.5 h-4 w-4"
        />
        <span>I understand this creates a new disabled rule version and makes earlier approval evidence stale.</span>
      </label>
      <Button type="button" onClick={save} disabled={!confirmed || isPending}>
        <PencilLine className="mr-2 h-4 w-4" aria-hidden="true" />
        {isPending ? "Working..." : "Save disabled rule draft"}
      </Button>

      <div className="space-y-3 rounded-md border border-dashed p-4">
        <div>
          <p className="flex items-center gap-2 font-medium"><FlaskConical className="h-4 w-4" aria-hidden="true" />No-delivery simulator</p>
          <p className="text-sm text-muted-foreground">Evaluate conditions in memory. This never records an execution or attempts delivery.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm"><span>Plate</span><Input value={plateNumber} onChange={(event) => setPlateNumber(event.target.value)} /></label>
          <label className="space-y-1 text-sm"><span>Camera</span><Input value={cameraName} onChange={(event) => setCameraName(event.target.value)} /></label>
          <label className="space-y-1 text-sm"><span>Tags</span><Input value={testTags} onChange={(event) => setTestTags(event.target.value)} /></label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={knownPlate} onChange={(event) => setKnownPlate(event.target.checked)} className="h-4 w-4" />
          Simulate as a known plate
        </label>
        <Button type="button" variant="outline" onClick={simulate} disabled={isPending}>Run no-delivery test</Button>
        {simulation && (
          <div className={`rounded-md border p-3 text-sm ${simulation.matched ? "border-emerald-500/40 bg-emerald-500/5" : ""}`}>
            <p className="font-medium">{simulation.matched ? "Conditions matched" : "Conditions did not match"}</p>
            <p className="text-muted-foreground">{simulation.reason}; {simulation.deliveryAttempts} delivery attempts.</p>
          </div>
        )}
      </div>

      {message && (
        <p role="status" className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-emerald-700 dark:text-emerald-300"}>
          {message.text}
        </p>
      )}
    </div>
  );
}

export function NotificationRuleDraftEditor({ review }) {
  const drafts = useMemo(
    () => (review?.rules || []).map(editableDraft).filter(Boolean),
    [review]
  );
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" aria-hidden="true" />Disabled unified-rule editor</CardTitle>
            <CardDescription className="mt-1 max-w-3xl">Edit migrated tag-and-camera rules only while the rule, channel, and actions are disabled. Saving never enables or delivers anything.</CardDescription>
          </div>
          <Badge variant="outline">{drafts.length} editable</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {drafts.length === 0
          ? <p className="rounded-md border p-4 text-sm text-muted-foreground">No safely disabled tag-and-camera rules are available to edit.</p>
          : drafts.map((draft) => <DraftRule key={draft.ruleId} draft={draft} />)}
      </CardContent>
    </Card>
  );
}

export const notificationRuleDraftEditorInternals = Object.freeze({ editableDraft });
