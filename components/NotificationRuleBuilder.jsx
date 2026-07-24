"use client";

import { BellRing, FlaskConical, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import {
  previewNotificationRuleBuilderDraft,
  saveNotificationRuleBuilderDraft,
  toggleNotificationRuleBuilder,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const CONDITION_LABELS = {
  always: "Any accepted read",
  plate_match: "Plate text",
  known_plate: "Known plate",
  known_name: "Known-plate name",
  tag: "Tag",
  watchlist: "Monitored plate",
  camera: "Camera",
  confidence: "Confidence",
  read_count: "Read count",
  local_time_window: "Schedule",
};
const WEEKDAYS = [
  [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"],
];

function token() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultCondition() {
  return { kind: "condition", key: token(), conditionType: "always", operator: "always", value: {} };
}

function defaultGroup(combinator = "all") {
  return { kind: "group", key: token(), combinator, children: [defaultCondition()] };
}

function defaultAction(options) {
  const broker = options.brokers.find((candidate) => candidate.enabled) || options.brokers[0];
  return {
    key: token(),
    channelType: broker ? "mqtt" : "pushover",
    configuration: { brokerId: broker?.id || "", destinationMode: "per_camera", fixedTopic: "", message: "", priority: 1 },
  };
}

function emptyDraft(options) {
  return {
    ruleId: null,
    name: "",
    description: "",
    cooldownSeconds: 0,
    conditionTree: defaultGroup(),
    actions: [defaultAction(options)],
  };
}

function nodeFromStored(node) {
  if (node.kind === "group") {
    return { ...node, key: token(), children: (node.children || []).map(nodeFromStored) };
  }
  return { ...node, key: token(), value: { ...(node.value || {}) } };
}

function draftFromRule(rule) {
  const root = rule.conditionTree;
  if (!root || root.kind !== "group") return null;
  return {
    ruleId: rule.id,
    name: rule.name,
    description: rule.description || "",
    cooldownSeconds: rule.cooldownSeconds,
    conditionTree: nodeFromStored(root),
    actions: rule.actions.map((action) => ({
      key: token(),
      channelType: action.channelType,
      configuration: { ...action.configuration },
    })),
  };
}

function cleanCondition(condition) {
  const type = condition.conditionType;
  if (type === "always") return { kind: "condition", conditionType: type, operator: "always", value: {} };
  if (type === "plate_match") return { kind: "condition", conditionType: type, operator: "matches", value: { plate: condition.value.plate || "", mode: condition.value.mode || "off", strategy: condition.value.strategy || "profile", maximumDistance: condition.value.maximumDistance ?? 1 } };
  if (type === "known_plate" || type === "watchlist") return { kind: "condition", conditionType: type, operator: "is_true", value: { expected: true } };
  if (type === "known_name") return { kind: "condition", conditionType: type, operator: "in", value: { names: condition.value.names || [] } };
  if (type === "tag") return { kind: "condition", conditionType: type, operator: "any", value: { tags: condition.value.tags || [] } };
  if (type === "camera") return { kind: "condition", conditionType: type, operator: "in", value: { names: condition.value.names || [] } };
  if (type === "confidence") return { kind: "condition", conditionType: type, operator: condition.operator || "at_least", value: { threshold: condition.value.threshold ?? 80 } };
  if (type === "read_count") return { kind: "condition", conditionType: type, operator: condition.operator || "at_least", value: { scope: condition.value.scope || "plate", count: condition.value.count ?? 1, windowSeconds: condition.value.windowSeconds ?? 0 } };
  return {
    kind: "condition",
    conditionType: type,
    operator: "within",
    value: {
      start: condition.value.start || "00:00",
      end: condition.value.end || "23:59",
      weekdays: condition.value.weekdays || [],
      timeZone: condition.value.timeZone || "America/Denver",
    },
  };
}

function cleanNode(node) {
  if (node.kind === "group") return { kind: "group", combinator: node.combinator, children: node.children.map(cleanNode) };
  return cleanCondition(node);
}

function payloadFor(draft) {
  return {
    name: draft.name,
    description: draft.description,
    cooldownSeconds: Number(draft.cooldownSeconds),
    conditionTree: cleanNode(draft.conditionTree),
    actions: draft.actions.map(({ channelType, configuration }) => ({ channelType, configuration })),
  };
}

function Select({ value, onChange, children, className = "" }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)} className={`h-9 rounded-md border bg-background px-3 text-sm ${className}`}>{children}</select>;
}

function ConditionValue({ condition, update, options }) {
  const value = condition.value || {};
  if (["always", "known_plate", "watchlist"].includes(condition.conditionType)) {
    return <p className="text-sm text-muted-foreground">No additional value needed.</p>;
  }
  if (condition.conditionType === "plate_match") {
    const strategy = value.strategy || "profile";
    return <div className="grid gap-2 sm:grid-cols-[1fr_190px_150px]">
      <Input value={value.plate || ""} onChange={(event) => update({ value: { ...value, plate: event.target.value.toUpperCase() } })} placeholder="ABC123" />
      <Select value={strategy} onChange={(next) => update({ value: { ...value, strategy: next } })}>
        <option value="profile">Shared fuzzy profile</option><option value="exact">Exact</option><option value="contains">Contains</option><option value="wildcard">Wildcard (* and ?)</option><option value="ocr_confusion">OCR confusion only</option><option value="edit_distance">Edit distance</option>
      </Select>
      {strategy === "profile" ? <Select value={value.mode || "off"} onChange={(mode) => update({ value: { ...value, mode } })}>
        <option value="off">Exact only</option><option value="strict">Strict fuzzy</option><option value="balanced">Balanced fuzzy</option><option value="broad">Broad fuzzy</option>
      </Select> : strategy === "edit_distance" ? <Input type="number" min="0" max="3" value={value.maximumDistance ?? 1} onChange={(event) => update({ value: { ...value, maximumDistance: Number(event.target.value) } })} aria-label="Maximum edit distance" /> : <span className="self-center text-xs text-muted-foreground">{strategy === "wildcard" ? "* = many, ? = one" : "Deterministic match"}</span>}
    </div>;
  }
  if (condition.conditionType === "tag") {
    return <div className="flex flex-wrap gap-2">{options.tags.map((tag) => {
      const selected = (value.tags || []).includes(tag.name);
      return <button type="button" key={tag.id} onClick={() => update({ value: { ...value, tags: selected ? value.tags.filter((name) => name !== tag.name) : [...(value.tags || []), tag.name] } })} className={`rounded-full border px-3 py-1 text-sm ${selected ? "border-primary bg-primary text-primary-foreground" : ""}`}>{tag.name}</button>;
    })}</div>;
  }
  if (condition.conditionType === "known_name") {
    return <Input value={(value.names || []).join(", ")} onChange={(event) => update({ value: { ...value, names: event.target.value.split(",").map((name) => name.trim()).filter(Boolean) } })} placeholder="Family car, Delivery van" />;
  }
  if (condition.conditionType === "camera") {
    return <div className="flex flex-wrap gap-2">{options.cameras.map((camera) => {
      const selected = (value.names || []).includes(camera);
      return <button type="button" key={camera} onClick={() => update({ value: { ...value, names: selected ? value.names.filter((name) => name !== camera) : [...(value.names || []), camera] } })} className={`rounded-full border px-3 py-1 text-sm ${selected ? "border-primary bg-primary text-primary-foreground" : ""}`}>{camera}</button>;
    })}</div>;
  }
  if (condition.conditionType === "confidence") {
    return <div className="grid gap-2 sm:grid-cols-[150px_160px]">
      <Select value={condition.operator || "at_least"} onChange={(operator) => update({ operator })}><option value="at_least">At least</option><option value="at_most">At most</option></Select>
      <Input type="number" min="0" max="100" value={value.threshold ?? 80} onChange={(event) => update({ value: { ...value, threshold: Number(event.target.value) } })} aria-label="Confidence percent" />
    </div>;
  }
  if (condition.conditionType === "read_count") {
    const seconds = Number(value.windowSeconds || 0);
    const inferredUnit = seconds === 0 ? "lifetime" : seconds % 86400 === 0 ? "days" : seconds % 3600 === 0 ? "hours" : "minutes";
    const unit = value.windowUnit || inferredUnit;
    const multiplier = unit === "days" ? 86400 : unit === "hours" ? 3600 : 60;
    const amount = unit === "lifetime" ? 0 : Math.max(1, seconds / multiplier || 1);
    return <div className="grid gap-2 sm:grid-cols-5">
      <Select value={value.scope || "plate"} onChange={(scope) => update({ value: { ...value, scope } })}><option value="plate">Same plate</option><option value="camera">Same camera</option><option value="global">All reads</option></Select>
      <Select value={condition.operator || "at_least"} onChange={(operator) => update({ operator })}><option value="at_least">At least</option><option value="at_most">At most</option><option value="equals">Exactly</option></Select>
      <Input type="number" min="0" max="1000000000" value={value.count ?? 1} onChange={(event) => update({ value: { ...value, count: Number(event.target.value) } })} aria-label="Read count" />
      <Select value={unit} onChange={(windowUnit) => update({ value: { ...value, windowUnit, windowSeconds: windowUnit === "lifetime" ? 0 : (windowUnit === "days" ? 86400 : windowUnit === "hours" ? 3600 : 60) } })}><option value="lifetime">Lifetime</option><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></Select>
      {unit === "lifetime" ? <span className="self-center text-xs text-muted-foreground">All retained reads</span> : <Input type="number" min="1" max="52596000" step="1" value={amount} onChange={(event) => update({ value: { ...value, windowUnit: unit, windowSeconds: Math.round(Number(event.target.value) * multiplier) } })} aria-label={`Period in ${unit}`} />}
    </div>;
  }
  return <div className="space-y-3">
    <div className="grid gap-2 sm:grid-cols-3">
      <Input type="time" value={value.start || "00:00"} onChange={(event) => update({ value: { ...value, start: event.target.value } })} />
      <Input type="time" value={value.end || "23:59"} onChange={(event) => update({ value: { ...value, end: event.target.value } })} />
      <Input value={value.timeZone || options.localTimeZone} onChange={(event) => update({ value: { ...value, timeZone: event.target.value } })} placeholder="America/Denver" />
    </div>
    <div className="flex flex-wrap gap-2">{WEEKDAYS.map(([day, label]) => {
      const selected = (value.weekdays || []).includes(day);
      return <button type="button" key={day} onClick={() => update({ value: { ...value, weekdays: selected ? value.weekdays.filter((entry) => entry !== day) : [...(value.weekdays || []), day] } })} className={`rounded border px-2 py-1 text-xs ${selected ? "bg-primary text-primary-foreground" : ""}`}>{label}</button>;
    })}<span className="self-center text-xs text-muted-foreground">No days selected means every day.</span></div>
  </div>;
}

function updateTree(node, key, updater) {
  if (node.key === key) return updater(node);
  if (node.kind !== "group") return node;
  return { ...node, children: node.children.map((child) => updateTree(child, key, updater)) };
}

function removeFromTree(node, key) {
  if (node.kind !== "group") return node;
  return { ...node, children: node.children.filter((child) => child.key !== key).map((child) => removeFromTree(child, key)) };
}

function ConditionTreeEditor({ node, depth = 1, options, update, remove, isRoot = false }) {
  if (node.kind === "condition") {
    return <div className="space-y-3 rounded-lg border p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]"><Select value={node.conditionType} onChange={(conditionType) => update({ ...node, conditionType, operator: "", value: conditionType === "local_time_window" ? { start: "00:00", end: "23:59", weekdays: [], timeZone: options.localTimeZone } : {} })}>{Object.entries(CONDITION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select><Button type="button" variant="ghost" size="icon" onClick={remove} aria-label="Remove condition"><Trash2 className="h-4 w-4" /></Button></div>
      <ConditionValue condition={node} update={(changes) => update({ ...node, ...changes })} options={options} />
    </div>;
  }
  return <div className={`space-y-3 rounded-lg border p-3 ${depth > 1 ? "ml-3 border-l-4" : ""}`}>
    <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{isRoot ? "Root" : `Nested level ${depth}`}</span><Select value={node.combinator} onChange={(combinator) => update({ ...node, combinator, children: combinator === "not" ? node.children.slice(0, 1) : node.children })}><option value="all">All (AND)</option><option value="any">Any (OR)</option><option value="not">Not</option></Select><span className="text-xs text-muted-foreground">{node.combinator === "not" ? "matches when its single child does not" : "of the following must match"}</span>{!isRoot && <Button type="button" variant="ghost" size="icon" onClick={remove} aria-label="Remove group"><Trash2 className="h-4 w-4" /></Button>}</div>
    <div className="space-y-3">{node.children.map((child) => <ConditionTreeEditor key={child.key} node={child} depth={depth + 1} options={options} update={(next) => update(updateTree(node, child.key, () => next))} remove={() => update(removeFromTree(node, child.key))} />)}</div>
    <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={node.combinator === "not" && node.children.length >= 1} onClick={() => update({ ...node, children: [...node.children, defaultCondition()] })}><Plus className="mr-1 h-4 w-4" />Condition</Button><Button type="button" size="sm" variant="outline" disabled={depth >= 6 || (node.combinator === "not" && node.children.length >= 1)} onClick={() => update({ ...node, children: [...node.children, defaultGroup("any")] })}><Plus className="mr-1 h-4 w-4" />Nested group</Button></div>
  </div>;
}

function ActionEditor({ action, update, remove, options }) {
  const config = action.configuration || {};
  return <div className="space-y-3 rounded-lg border p-3">
    <div className="flex items-center gap-2">
      <Select value={action.channelType} onChange={(channelType) => update({ channelType })} className="flex-1"><option value="mqtt">MQTT</option><option value="pushover">Pushover</option></Select>
      <Button type="button" variant="ghost" size="icon" onClick={remove} aria-label="Remove action"><Trash2 className="h-4 w-4" /></Button>
    </div>
    {action.channelType === "mqtt" ? <>
      <div className="grid gap-2 sm:grid-cols-2">
        <Select value={String(config.brokerId || "")} onChange={(brokerId) => update({ configuration: { ...config, brokerId: Number(brokerId) } })}>
          <option value="">Select broker</option>{options.brokers.map((broker) => <option key={broker.id} value={broker.id}>{broker.name}{broker.enabled ? "" : " (disabled)"}</option>)}
        </Select>
        <Select value={config.destinationMode || "per_camera"} onChange={(destinationMode) => update({ configuration: { ...config, destinationMode } })}><option value="per_camera">Per-camera topic</option><option value="fixed_topic">Fixed topic</option></Select>
      </div>
      {config.destinationMode === "fixed_topic" && <Input value={config.fixedTopic || ""} onChange={(event) => update({ configuration: { ...config, fixedTopic: event.target.value } })} placeholder="alpr/alerts" />}
      <Input value={config.message || ""} onChange={(event) => update({ configuration: { ...config, message: event.target.value } })} placeholder="Optional MQTT message" />
    </> : <>
      <Select value={String(config.priority ?? 1)} onChange={(priority) => update({ configuration: { ...config, priority: Number(priority) } })}><option value="-2">Lowest priority</option><option value="-1">Low priority</option><option value="0">Normal priority</option><option value="1">High priority</option><option value="2">Emergency priority</option></Select>
      <Input value={config.message || ""} onChange={(event) => update({ configuration: { ...config, message: event.target.value } })} placeholder="Optional Pushover message" />
    </>}
  </div>;
}

export function NotificationRuleBuilder({ overview }) {
  const router = useRouter();
  const options = overview?.options || { tags: [], cameras: [], brokers: [], localTimeZone: "America/Denver" };
  const rules = useMemo(() => overview?.rules || [], [overview?.rules]);
  const [draft, setDraft] = useState(() => emptyDraft(options));
  const [message, setMessage] = useState(null);
  const [preview, setPreview] = useState(null);
  const [isPending, startTransition] = useTransition();
  const editable = useMemo(() => rules.filter((rule) => !rule.managedByMigration), [rules]);

  function patchAction(key, changes) {
    setDraft((current) => ({ ...current, actions: current.actions.map((action) => action.key === key ? { ...action, ...changes } : action) }));
  }
  function save() {
    setMessage(null); setPreview(null);
    startTransition(async () => {
      const formData = new FormData();
      if (draft.ruleId) formData.set("ruleId", String(draft.ruleId));
      formData.set("draft", JSON.stringify(payloadFor(draft)));
      formData.set("confirmation", "save_disabled_notification_rule");
      const result = await saveNotificationRuleBuilderDraft(formData);
      if (!result.success) return setMessage({ kind: "error", text: result.error });
      setMessage({ kind: "success", text: `Saved rule #${result.data.ruleId} as disabled version ${result.data.version}.` });
      router.refresh();
    });
  }
  function runPreview(id) {
    setMessage(null);
    startTransition(async () => {
      const formData = new FormData(); formData.set("ruleId", String(id)); formData.set("limit", "25");
      const result = await previewNotificationRuleBuilderDraft(formData);
      if (!result.success) return setMessage({ kind: "error", text: result.error });
      setPreview(result.data);
    });
  }
  function toggle(rule) {
    const verb = rule.enabled ? "deactivate" : "activate";
    if (!window.confirm(`${verb[0].toUpperCase()}${verb.slice(1)} “${rule.name}”?`)) return;
    setMessage(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("ruleId", String(rule.id)); formData.set("enabled", String(!rule.enabled));
      formData.set("confirmation", rule.enabled ? "deactivate_notification_rule" : "activate_notification_rule");
      const result = await toggleNotificationRuleBuilder(formData);
      if (!result.success) return setMessage({ kind: "error", text: result.error });
      setMessage({ kind: "success", text: `${rule.name} is now ${result.data.enabled ? "active" : "disabled"}.` });
      router.refresh();
    });
  }

  if (!overview) {
    return <Card><CardHeader><CardTitle>Unified notification rules</CardTitle><CardDescription>The rule builder could not be loaded. No rule changes are available from this view.</CardDescription></CardHeader></Card>;
  }

  return <Card>
    <CardHeader>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><CardTitle className="flex items-center gap-2"><BellRing className="h-5 w-5" />Unified notification rules</CardTitle><CardDescription className="mt-1 max-w-3xl">Build MQTT and Pushover rules from accepted reads. Saving always creates a disabled draft; preview never sends a notification; activation is separate and audited.</CardDescription></div>
        <Badge variant="outline"><ShieldCheck className="mr-1 h-3 w-3" />Safe draft workflow</Badge>
      </div>
    </CardHeader>
    <CardContent className="space-y-6">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-md border p-3"><p className="text-xs uppercase text-muted-foreground">Rules</p><p className="text-2xl font-semibold">{rules.length}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs uppercase text-muted-foreground">MQTT</p><p className="text-sm font-medium">{options.mqttEnabled ? "Ready" : "Disabled"}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs uppercase text-muted-foreground">Pushover</p><p className="text-sm font-medium">{options.pushoverEnabled && options.pushoverConfigured ? "Ready" : "Not ready"}</p></div>
      </div>

      {editable.length > 0 && <div className="space-y-2"><h3 className="font-medium">Your rules</h3>{editable.map((rule) => <div key={rule.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div><div className="flex items-center gap-2"><span className="font-medium">{rule.name}</span><Badge variant={rule.enabled ? "default" : "secondary"}>{rule.enabled ? "Active" : "Disabled"}</Badge><Badge variant="outline">v{rule.version}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{rule.actions.map((action) => action.channelType.toUpperCase()).join(" + ")} · {rule.cooldownSeconds ? `${rule.cooldownSeconds}s cooldown` : "No cooldown"}</p></div><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={isPending || rule.enabled} onClick={() => { const next = draftFromRule(rule); if (next) { setDraft(next); setPreview(null); setMessage(null); } else setMessage({ kind: "error", text: "This rule does not have a valid editable condition tree." }); }}>Edit</Button><Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => runPreview(rule.id)}><FlaskConical className="mr-1 h-4 w-4" />Preview</Button><Button type="button" size="sm" variant={rule.enabled ? "destructive" : "default"} disabled={isPending} onClick={() => toggle(rule)}>{rule.enabled ? "Deactivate" : "Activate"}</Button></div></div>)}</div>}

      <div className="space-y-4 rounded-xl border p-4">
        <div className="flex items-center justify-between"><div><h3 className="font-semibold">{draft.ruleId ? `Edit disabled rule #${draft.ruleId}` : "New disabled rule"}</h3><p className="text-sm text-muted-foreground">Combine AND, OR, and NOT groups up to six levels deep.</p></div>{draft.ruleId && <Button type="button" variant="ghost" onClick={() => setDraft(emptyDraft(options))}>New rule</Button>}</div>
        <div className="grid gap-3 md:grid-cols-2"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Rule name" /><Input type="number" min="0" max="2678400" value={draft.cooldownSeconds} onChange={(event) => setDraft({ ...draft, cooldownSeconds: event.target.value })} placeholder="Cooldown seconds" /></div>
        <Textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Optional description" />
        <ConditionTreeEditor node={draft.conditionTree} options={options} isRoot update={(conditionTree) => setDraft({ ...draft, conditionTree })} remove={() => {}} />
        <div className="space-y-3"><h4 className="font-medium">Actions</h4>{draft.actions.map((action) => <ActionEditor key={action.key} action={action} options={options} update={(changes) => patchAction(action.key, changes)} remove={() => setDraft({ ...draft, actions: draft.actions.filter((entry) => entry.key !== action.key) })} />)}<Button type="button" variant="outline" onClick={() => setDraft({ ...draft, actions: [...draft.actions, defaultAction(options)] })}><Plus className="mr-1 h-4 w-4" />Add action</Button></div>
        <div className="flex flex-wrap items-center gap-3"><Button type="button" disabled={isPending} onClick={save}><Save className="mr-1 h-4 w-4" />{isPending ? "Working…" : "Save disabled draft"}</Button><p className="text-xs text-muted-foreground">Saving never activates delivery.</p></div>
      </div>

      {message && <p className={`rounded-md border p-3 text-sm ${message.kind === "error" ? "border-destructive/50 text-destructive" : "border-emerald-500/50 text-emerald-700 dark:text-emerald-300"}`}>{message.text}</p>}
      {preview && <div className="rounded-lg border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">Recent-read preview</h3><Badge variant="outline">{preview.matchCount} of {preview.sampleCount} matched</Badge></div><p className="mt-1 text-xs text-muted-foreground">Rule v{preview.ruleVersion}; {preview.deliveryAttempts} delivery attempts. Expand a row to inspect the condition trace.</p><div className="mt-3 max-h-96 space-y-2 overflow-y-auto pr-1">{preview.samples.map((sample) => <details key={sample.readId} className="rounded border p-2 text-sm"><summary className="flex cursor-pointer items-center justify-between gap-3"><span>{sample.plateNumber} · {sample.cameraName}</span><Badge variant={sample.matched ? "default" : "secondary"}>{sample.matched ? "Match" : "No match"}</Badge></summary><pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">{JSON.stringify(sample.trace, null, 2)}</pre></details>)}</div></div>}

      {rules.some((rule) => rule.managedByMigration) && <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">Migrated rules remain below in the migration review and guarded cutover sections. This builder cannot bypass those protections.</p>}
    </CardContent>
  </Card>;
}

export const notificationRuleBuilderUiInternals = Object.freeze({ cleanCondition, cleanNode, draftFromRule, payloadFor, removeFromTree, updateTree });
