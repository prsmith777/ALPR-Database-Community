"use client";

import { BellRing, FlaskConical, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import {
  deleteNotificationRuleBuilder,
  previewNotificationRuleBuilderDraft,
  saveNotificationRuleBuilderDraft,
  toggleNotificationRuleBuilder,
} from "@/app/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { preferredRuleTimeZone, scheduleConditionTimeZone, syncQuietHoursTimeZone } from "@/lib/notification-rule-time-zone.mjs";

const CONDITION_LABELS = {
  always: "Any event",
  plate_match: "Plate text",
  known_plate: "Known plate",
  known_name: "Known-plate name",
  tag: "Tag",
  watchlist: "Monitored plate",
  camera: "Camera",
  direction: "Vehicle direction",
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

function defaultActivityGroup() {
  return {
    kind: "group",
    key: token(),
    combinator: "all",
    children: [
      { kind: "condition", key: token(), conditionType: "camera", operator: "in", value: { names: [] } },
      { kind: "condition", key: token(), conditionType: "read_count", operator: "at_most", value: { scope: "camera", count: 0, windowSeconds: 900 } },
    ],
  };
}

function defaultDirectionGroup() {
  return {
    kind: "group",
    key: token(),
    combinator: "all",
    children: [
      { kind: "condition", key: token(), conditionType: "direction", operator: "in", value: { labels: [] } },
    ],
  };
}

function defaultAction(options) {
  const broker = options.brokers.find((candidate) => candidate.enabled) || options.brokers[0];
  const channelType = broker
    ? "mqtt"
    : options.pushoverEnabled && options.pushoverConfigured
      ? "pushover"
      : options.emailEnabled && options.emailConfigured
        ? "email"
        : options.webhookEnabled && options.webhookConfigured ? "webhook" : "pushover";
  return {
    key: token(),
    channelType,
    configuration: { brokerId: broker?.id || "", destinationMode: "per_camera", fixedTopic: "", message: "", priority: 1, recipients: [], subject: "", attachImage: true, url: "" },
  };
}

function emptyDraft(options) {
  return {
    ruleId: null,
    name: "",
    description: "",
    eventType: "plate_read.accepted",
    timeZone: options.localTimeZone,
    evaluationIntervalSeconds: 300,
    quietHours: { enabled: false, start: "22:00", end: "06:00", weekdays: [], timeZone: options.localTimeZone },
    cooldownSeconds: 0,
    conditionTree: defaultGroup(),
    actions: [defaultAction(options)],
  };
}

function resolvedBrowserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
}

function browserDraft(options) {
  const localTimeZone = preferredRuleTimeZone({
    browserTimeZone: resolvedBrowserTimeZone(),
    configuredTimeZone: options.localTimeZone,
  });
  return emptyDraft({ ...options, localTimeZone });
}

function nodeFromStored(node, { priorTimeZone, nextTimeZone } = {}) {
  if (node.kind === "group") {
    return { ...node, key: token(), children: (node.children || []).map((child) => nodeFromStored(child, { priorTimeZone, nextTimeZone })) };
  }
  const value = { ...(node.value || {}) };
  if (node.conditionType === "local_time_window" && value.timeZone === priorTimeZone) {
    value.timeZone = nextTimeZone;
  }
  return { ...node, key: token(), value };
}

function draftFromRule(rule, options) {
  const root = rule.conditionTree;
  if (!root || root.kind !== "group") return null;
  const storedTimeZone = rule.timeZone || "UTC";
  const timeZone = rule.migratedFromLegacy && storedTimeZone === "UTC"
    ? preferredRuleTimeZone({ browserTimeZone: resolvedBrowserTimeZone(), configuredTimeZone: options.localTimeZone })
    : storedTimeZone;
  return {
    ruleId: rule.id,
    name: rule.name,
    description: rule.description || "",
    eventType: rule.eventType || "plate_read.accepted",
    timeZone,
    evaluationIntervalSeconds: rule.evaluationIntervalSeconds || 300,
    quietHours: syncQuietHoursTimeZone({
      quietHours: { enabled: false, start: "22:00", end: "06:00", weekdays: [], timeZone: storedTimeZone, ...(rule.quietHours || {}) },
      priorRuleTimeZone: storedTimeZone,
      nextRuleTimeZone: timeZone,
    }),
    cooldownSeconds: rule.cooldownSeconds,
    conditionTree: nodeFromStored(root, { priorTimeZone: storedTimeZone, nextTimeZone: timeZone }),
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
  if (type === "direction") return { kind: "condition", conditionType: type, operator: "in", value: { labels: condition.value.labels || [] } };
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
    eventType: draft.eventType,
    timeZone: draft.timeZone,
    evaluationIntervalSeconds: Number(draft.evaluationIntervalSeconds),
    quietHours: draft.quietHours,
    cooldownSeconds: Number(draft.cooldownSeconds),
    conditionTree: cleanNode(draft.conditionTree),
    actions: draft.actions.map(({ channelType, configuration }) => ({ channelType, configuration })),
  };
}

function Select({ value, onChange, children, className = "" }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)} className={`h-9 rounded-md border bg-background px-3 text-sm ${className}`}>{children}</select>;
}

function ConditionValue({ condition, update, options, ruleTimeZone }) {
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
  if (condition.conditionType === "direction") {
    return <div className="flex flex-wrap gap-2">{(options.directions || []).map((direction) => {
      const selected = (value.labels || []).includes(direction);
      return <button type="button" key={direction} onClick={() => update({ value: { ...value, labels: selected ? value.labels.filter((label) => label !== direction) : [...(value.labels || []), direction] } })} className={`rounded-full border px-3 py-1 text-sm ${selected ? "border-primary bg-primary text-primary-foreground" : ""}`}>{direction}</button>;
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
      <Input value={value.timeZone || ruleTimeZone || options.localTimeZone} onChange={(event) => update({ value: { ...value, timeZone: event.target.value } })} placeholder="America/Denver" />
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

function ConditionTreeEditor({ node, depth = 1, options, ruleTimeZone, update, remove, isRoot = false }) {
  if (node.kind === "condition") {
    return <div className="space-y-3 rounded-lg border p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]"><Select value={node.conditionType} onChange={(conditionType) => update({ ...node, conditionType, operator: "", value: conditionType === "local_time_window" ? { start: "00:00", end: "23:59", weekdays: [], timeZone: scheduleConditionTimeZone({ ruleTimeZone, configuredTimeZone: options.localTimeZone }) } : {} })}>{Object.entries(CONDITION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select><Button type="button" variant="ghost" size="icon" onClick={remove} aria-label="Remove condition"><Trash2 className="h-4 w-4" /></Button></div>
      <ConditionValue condition={node} update={(changes) => update({ ...node, ...changes })} options={options} ruleTimeZone={ruleTimeZone} />
    </div>;
  }
  return <div className={`space-y-3 rounded-lg border p-3 ${depth > 1 ? "ml-3 border-l-4" : ""}`}>
    <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{isRoot ? "Root" : `Nested level ${depth}`}</span><Select value={node.combinator} onChange={(combinator) => update({ ...node, combinator, children: combinator === "not" ? node.children.slice(0, 1) : node.children })}><option value="all">All (AND)</option><option value="any">Any (OR)</option><option value="not">Not</option></Select><span className="text-xs text-muted-foreground">{node.combinator === "not" ? "matches when its single child does not" : "of the following must match"}</span>{!isRoot && <Button type="button" variant="ghost" size="icon" onClick={remove} aria-label="Remove group"><Trash2 className="h-4 w-4" /></Button>}</div>
    <div className="space-y-3">{node.children.map((child) => <ConditionTreeEditor key={child.key} node={child} depth={depth + 1} options={options} ruleTimeZone={ruleTimeZone} update={(next) => update(updateTree(node, child.key, () => next))} remove={() => update(removeFromTree(node, child.key))} />)}</div>
    <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={node.combinator === "not" && node.children.length >= 1} onClick={() => update({ ...node, children: [...node.children, defaultCondition()] })}><Plus className="mr-1 h-4 w-4" />Condition</Button><Button type="button" size="sm" variant="outline" disabled={depth >= 6 || (node.combinator === "not" && node.children.length >= 1)} onClick={() => update({ ...node, children: [...node.children, defaultGroup("any")] })}><Plus className="mr-1 h-4 w-4" />Nested group</Button></div>
  </div>;
}

function ActionEditor({ action, update, remove, options }) {
  const config = action.configuration || {};
  return <div className="space-y-3 rounded-lg border p-3">
    <div className="flex items-center gap-2">
      <Select value={action.channelType} onChange={(channelType) => update({ channelType })} className="flex-1"><option value="mqtt">MQTT</option><option value="pushover">Pushover</option><option value="email">Email</option><option value="webhook">Webhook</option></Select>
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
    </> : action.channelType === "pushover" ? <>
      <Select value={String(config.priority ?? 1)} onChange={(priority) => update({ configuration: { ...config, priority: Number(priority) } })}><option value="-2">Lowest priority</option><option value="-1">Low priority</option><option value="0">Normal priority</option><option value="1">High priority</option><option value="2">Emergency priority</option></Select>
      <Input value={config.message || ""} onChange={(event) => update({ configuration: { ...config, message: event.target.value } })} placeholder="Optional Pushover message" />
    </> : action.channelType === "email" ? <>
      <Input value={(config.recipients || []).join?.(", ") || config.recipients || ""} onChange={(event) => update({ configuration: { ...config, recipients: event.target.value.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean) } })} placeholder="recipient@example.com, another@example.com" aria-label="Email recipients" />
      <Input value={config.subject || ""} onChange={(event) => update({ configuration: { ...config, subject: event.target.value } })} placeholder="Optional email subject" />
      <Textarea value={config.message || ""} onChange={(event) => update({ configuration: { ...config, message: event.target.value } })} placeholder="Optional email message" />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.attachImage !== false} onChange={(event) => update({ configuration: { ...config, attachImage: event.target.checked } })} />Attach the captured image when available</label>
    </> : <>
      <Input type="url" value={config.url || ""} onChange={(event) => update({ configuration: { ...config, url: event.target.value } })} placeholder="https://automation.example.com/alpr" aria-label="Webhook URL" />
      <Textarea value={config.message || ""} onChange={(event) => update({ configuration: { ...config, message: event.target.value } })} placeholder="Optional webhook message" />
      <p className="text-xs text-muted-foreground">JSON is signed in X-ALPR-Signature and sent without following redirects.</p>
    </>}
  </div>;
}

export function NotificationRuleBuilder({ overview }) {
  const router = useRouter();
  const options = overview?.options || { tags: [], cameras: [], directions: [], brokers: [], localTimeZone: "America/Denver" };
  const rules = useMemo(() => overview?.rules || [], [overview?.rules]);
  const [draft, setDraft] = useState(() => emptyDraft(options));
  const [message, setMessage] = useState(null);
  const [preview, setPreview] = useState(null);
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [view, setView] = useState("list");
  const [isPending, startTransition] = useTransition();
  const editable = useMemo(() => rules.filter((rule) => !rule.managedByMigration), [rules]);

  useEffect(() => {
    const browserTimeZone = resolvedBrowserTimeZone();
    const preferred = preferredRuleTimeZone({ browserTimeZone, configuredTimeZone: options.localTimeZone });
    setDraft((current) => {
      if (current.ruleId || current.name || current.timeZone !== options.localTimeZone || current.timeZone === preferred) return current;
      return {
        ...current,
        timeZone: preferred,
        quietHours: syncQuietHoursTimeZone({
          quietHours: current.quietHours,
          priorRuleTimeZone: current.timeZone,
          nextRuleTimeZone: preferred,
        }),
      };
    });
  }, [options.localTimeZone]);

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
      setView("list");
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
  function confirmDelete() {
    if (!deleteCandidate) return;
    const rule = deleteCandidate;
    setMessage(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("ruleId", String(rule.id));
      formData.set("ruleName", rule.name);
      formData.set("confirmation", "delete_disabled_notification_rule");
      const result = await deleteNotificationRuleBuilder(formData);
      if (!result.success) return setMessage({ kind: "error", text: result.error });
      setDeleteCandidate(null);
      setMessage({ kind: "success", text: `${rule.name} was deleted.` });
      router.refresh();
    });
  }

  if (!overview) {
    return <Card><CardHeader><CardTitle>Unified notification rules</CardTitle><CardDescription>The rule builder could not be loaded. No rule changes are available from this view.</CardDescription></CardHeader></Card>;
  }

  return <Card>
    <CardHeader>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><CardTitle className="flex items-center gap-2"><BellRing className="h-5 w-5" />Rules</CardTitle><CardDescription className="mt-1 max-w-3xl">Create a disabled draft, preview it against recent reads, and activate it when the result is correct.</CardDescription></div>
        <Badge variant="outline"><ShieldCheck className="mr-1 h-3 w-3" />Safe draft workflow</Badge>
      </div>
    </CardHeader>
    <CardContent className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-4">
        <div className="flex gap-6">
          <div><p className="text-xs uppercase text-muted-foreground">Total</p><p className="text-xl font-semibold">{editable.length}</p></div>
          <div><p className="text-xs uppercase text-muted-foreground">Active</p><p className="text-xl font-semibold">{editable.filter((rule) => rule.enabled).length}</p></div>
          <div><p className="text-xs uppercase text-muted-foreground">Disabled</p><p className="text-xl font-semibold">{editable.filter((rule) => !rule.enabled).length}</p></div>
        </div>
        <Button type="button" onClick={() => { setDraft(browserDraft(options)); setPreview(null); setMessage(null); setView("editor"); }}><Plus className="mr-2 h-4 w-4" />Create rule</Button>
      </div>

      {view === "list" && editable.length > 0 && <div className="space-y-2">
        <h3 className="font-medium">Your rules</h3>
        {editable.map((rule) => <div key={rule.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
          <div>
            <div className="flex items-center gap-2"><span className="font-medium">{rule.name}</span><Badge variant={rule.enabled ? "default" : "secondary"}>{rule.enabled ? "Active" : "Disabled"}</Badge><Badge variant="outline">v{rule.version}</Badge></div>
            <p className="mt-1 text-xs text-muted-foreground">{rule.actions.map((action) => action.channelType.toUpperCase()).join(" + ")} · {rule.cooldownSeconds ? `${rule.cooldownSeconds}s cooldown` : "No cooldown"}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={isPending || rule.enabled} onClick={() => { const next = draftFromRule(rule, options); if (next) { setDraft(next); setPreview(null); setMessage(null); setView("editor"); } else setMessage({ kind: "error", text: "This rule does not have a valid editable condition tree." }); }}>Edit</Button>
            <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => runPreview(rule.id)}><FlaskConical className="mr-1 h-4 w-4" />Preview</Button>
            <Button type="button" size="sm" variant={rule.enabled ? "destructive" : "default"} disabled={isPending} onClick={() => toggle(rule)}>{rule.enabled ? "Deactivate" : "Activate"}</Button>
            <Button type="button" variant="outline" size="sm" className="text-destructive hover:text-destructive" disabled={isPending || rule.enabled} onClick={() => setDeleteCandidate(rule)}><Trash2 className="mr-1 h-4 w-4" />Delete</Button>
          </div>
        </div>)}
      </div>}
      {view === "list" && editable.length === 0 && <div className="rounded-lg border border-dashed p-8 text-center"><p className="font-medium">No notification rules yet</p><p className="mt-1 text-sm text-muted-foreground">Create your first rule, preview it, then activate it when ready.</p></div>}

      {view === "editor" && <div className="space-y-4 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">{draft.ruleId ? `Edit disabled rule #${draft.ruleId}` : "Create a notification rule"}</h3><p className="text-sm text-muted-foreground">Name it, choose when it matches, then select one or more delivery actions.</p></div><Button type="button" variant="outline" onClick={() => { setView("list"); setMessage(null); }}>Back to rules</Button></div>
        <div className="grid gap-3 md:grid-cols-2"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Rule name" /><Input type="number" min="0" max="2678400" value={draft.cooldownSeconds} onChange={(event) => setDraft({ ...draft, cooldownSeconds: event.target.value })} placeholder="Cooldown seconds" /></div>
        <Textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Optional description" />
        <div className="grid gap-3 rounded-lg border p-3 md:grid-cols-3">
          <label className="space-y-1 text-sm"><span className="font-medium">Trigger</span><Select className="w-full" value={draft.eventType} onChange={(eventType) => setDraft({ ...draft, eventType, conditionTree: eventType === "camera.activity_check" ? defaultActivityGroup() : eventType === "vehicle.direction_classified" ? defaultDirectionGroup() : defaultGroup() })}><option value="plate_read.accepted">Accepted plate read</option><option value="vehicle.direction_classified">Vehicle direction classified</option><option value="camera.activity_check">Scheduled camera activity</option></Select></label>
          <label className="space-y-1 text-sm"><span className="font-medium">Rule time zone</span><Input value={draft.timeZone} onChange={(event) => { const nextRuleTimeZone = event.target.value; setDraft({ ...draft, timeZone: nextRuleTimeZone, quietHours: syncQuietHoursTimeZone({ quietHours: draft.quietHours, priorRuleTimeZone: draft.timeZone, nextRuleTimeZone }) }); }} placeholder="America/Denver" /></label>
          {draft.eventType === "camera.activity_check" ? <label className="space-y-1 text-sm"><span className="font-medium">Check every (seconds)</span><Input type="number" min="60" max="86400" value={draft.evaluationIntervalSeconds} onChange={(event) => setDraft({ ...draft, evaluationIntervalSeconds: event.target.value })} /></label> : <div className="self-end text-xs text-muted-foreground">Conditions use the read&apos;s stored event time.</div>}
        </div>
        <div className="space-y-3 rounded-lg border p-3">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={Boolean(draft.quietHours?.enabled)} onChange={(event) => setDraft({ ...draft, quietHours: { ...draft.quietHours, enabled: event.target.checked } })} />Quiet hours</label>
          {draft.quietHours?.enabled && <><div className="grid gap-2 sm:grid-cols-3"><Input type="time" value={draft.quietHours.start} onChange={(event) => setDraft({ ...draft, quietHours: { ...draft.quietHours, start: event.target.value } })} /><Input type="time" value={draft.quietHours.end} onChange={(event) => setDraft({ ...draft, quietHours: { ...draft.quietHours, end: event.target.value } })} /><Input value={draft.quietHours.timeZone || draft.timeZone} onChange={(event) => setDraft({ ...draft, quietHours: { ...draft.quietHours, timeZone: event.target.value } })} /></div><div className="flex flex-wrap gap-2">{WEEKDAYS.map(([day, label]) => { const selected = (draft.quietHours.weekdays || []).includes(day); return <button type="button" key={day} onClick={() => setDraft({ ...draft, quietHours: { ...draft.quietHours, weekdays: selected ? draft.quietHours.weekdays.filter((entry) => entry !== day) : [...(draft.quietHours.weekdays || []), day] } })} className={`rounded border px-2 py-1 text-xs ${selected ? "bg-primary text-primary-foreground" : ""}`}>{label}</button>; })}<span className="self-center text-xs text-muted-foreground">No days selected means every day.</span></div></>}
        </div>
        <ConditionTreeEditor node={draft.conditionTree} options={options} ruleTimeZone={draft.timeZone} isRoot update={(conditionTree) => setDraft({ ...draft, conditionTree })} remove={() => {}} />
        <div className="space-y-3"><h4 className="font-medium">Actions</h4>{draft.actions.map((action) => <ActionEditor key={action.key} action={action} options={options} update={(changes) => patchAction(action.key, changes)} remove={() => setDraft({ ...draft, actions: draft.actions.filter((entry) => entry.key !== action.key) })} />)}<Button type="button" variant="outline" onClick={() => setDraft({ ...draft, actions: [...draft.actions, defaultAction(options)] })}><Plus className="mr-1 h-4 w-4" />Add action</Button></div>
        <div className="flex flex-wrap items-center gap-3"><Button type="button" disabled={isPending} onClick={save}><Save className="mr-1 h-4 w-4" />{isPending ? "Working…" : "Save disabled draft"}</Button><p className="text-xs text-muted-foreground">Saving never activates delivery.</p></div>
      </div>}

      {message && <p className={`rounded-md border p-3 text-sm ${message.kind === "error" ? "border-destructive/50 text-destructive" : "border-emerald-500/50 text-emerald-700 dark:text-emerald-300"}`}>{message.text}</p>}
      {preview && <div className="rounded-lg border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">Recent-read preview</h3><Badge variant="outline">{preview.matchCount} of {preview.sampleCount} matched</Badge></div><p className="mt-1 text-xs text-muted-foreground">Rule v{preview.ruleVersion}; {preview.deliveryAttempts} delivery attempts. Expand a row to inspect the condition trace.</p><div className="mt-3 max-h-96 space-y-2 overflow-y-auto pr-1">{preview.samples.map((sample) => <details key={sample.readId} className="rounded border p-2 text-sm"><summary className="flex cursor-pointer items-center justify-between gap-3"><span>{sample.plateNumber} · {sample.cameraName}</span><Badge variant={sample.matched ? "default" : "secondary"}>{sample.matched ? "Match" : "No match"}</Badge></summary><pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">{JSON.stringify(sample.trace, null, 2)}</pre></details>)}</div></div>}

      <AlertDialog open={Boolean(deleteCandidate)} onOpenChange={(open) => { if (!open && !isPending) setDeleteCandidate(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete notification rule?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <strong>“{deleteCandidate?.name}”</strong> (version {deleteCandidate?.version})? It will disappear from Notification Rules and cannot evaluate or deliver again. Historical activity remains available. This cannot be undone from the interface.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={isPending} onClick={confirmDelete}>
              {isPending ? "Deleting…" : "Delete rule"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </CardContent>
  </Card>;
}

export const notificationRuleBuilderUiInternals = Object.freeze({ browserDraft, cleanCondition, cleanNode, draftFromRule, payloadFor, removeFromTree, updateTree });
