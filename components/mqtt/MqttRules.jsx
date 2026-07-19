"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Edit, ListFilter, Loader2, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { mqttRequest } from "./api";
import { StatusMessage } from "./StatusMessage";

const MATCH_LABELS = Object.freeze({
  any_plate: "Any plate",
  exact_plate: "Exact plate",
  any_known_plate: "Any known plate",
  known_name: "Known-plate name",
  tag: "Tag",
});

function makeEmptyRule(brokerId = "") {
  return {
    name: "",
    enabled: true,
    matchType: "any_plate",
    matchValue: "",
    fuzzyEnabled: false,
    fuzzyMaxDistance: 1,
    fuzzyMinLength: 5,
    fuzzyRequireUnique: true,
    fuzzyOcrAware: true,
    brokerId: brokerId ? String(brokerId) : "",
    destinationMode: "per_camera",
    fixedTopic: "",
    message: "",
    cameraIds: [],
  };
}

function matchDescription(rule) {
  const label = MATCH_LABELS[rule.matchType] || rule.matchType;
  return rule.matchValue ? `${label}: ${rule.matchValue}` : label;
}

function cameraDescription(rule, cameras) {
  if (!rule.cameraIds?.length) return "Any camera";
  const names = rule.cameraIds
    .map((id) => cameras.find((camera) => camera.id === id)?.cameraName)
    .filter(Boolean);
  return names.length ? names.join(", ") : `${rule.cameraIds.length} selected`;
}

export function MqttRules() {
  const [rules, setRules] = useState([]);
  const [options, setOptions] = useState({
    brokers: [],
    cameras: [],
    knownPlates: [],
    knownNames: [],
    tags: [],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [form, setForm] = useState(() => makeEmptyRule());

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const data = await mqttRequest("/api/mqtt/rules");
      const loadedOptions = data?.options || {
        brokers: [],
        cameras: [],
        knownPlates: [],
        knownNames: [],
        tags: [],
      };
      setRules(Array.isArray(data?.rules) ? data.rules : []);
      setOptions(loadedOptions);
      setForm((current) =>
        current.brokerId
          ? current
          : {
              ...current,
              brokerId: loadedOptions.brokers[0]?.id
                ? String(loadedOptions.brokers[0].id)
                : "",
            }
      );
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  const updateForm = (name, value) => {
    setForm((current) => ({ ...current, [name]: value }));
  };

  const openNew = () => {
    setEditingRule(null);
    setForm(makeEmptyRule(options.brokers[0]?.id || ""));
    setDialogOpen(true);
  };

  const openEdit = (rule) => {
    setEditingRule(rule);
    setForm({
      name: rule.name || "",
      enabled: Boolean(rule.enabled),
      matchType: rule.matchType,
      matchValue: rule.matchValue || "",
      fuzzyEnabled: Boolean(rule.fuzzyEnabled),
      fuzzyMaxDistance: Number(rule.fuzzyMaxDistance || 1),
      fuzzyMinLength: Number(rule.fuzzyMinLength || 5),
      fuzzyRequireUnique: Boolean(rule.fuzzyRequireUnique),
      fuzzyOcrAware: Boolean(rule.fuzzyOcrAware),
      brokerId: String(rule.brokerId || ""),
      destinationMode: rule.destinationMode || "per_camera",
      fixedTopic: rule.fixedTopic || "",
      message: rule.message || "",
      cameraIds: Array.isArray(rule.cameraIds) ? [...rule.cameraIds] : [],
    });
    setDialogOpen(true);
  };

  const toggleCamera = (cameraId, checked) => {
    setForm((current) => {
      const currentIds = new Set(current.cameraIds);
      if (checked) currentIds.add(cameraId);
      else currentIds.delete(cameraId);
      return {
        ...current,
        cameraIds: [...currentIds].sort((left, right) => left - right),
      };
    });
  };

  const saveRule = async (event) => {
    event.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      const payload = {
        ...form,
        brokerId: Number(form.brokerId),
        fuzzyMaxDistance: Number(form.fuzzyMaxDistance),
        fuzzyMinLength: Number(form.fuzzyMinLength),
      };

      if (editingRule) {
        await mqttRequest(`/api/mqtt/rules/${editingRule.id}`, {
          method: "PUT",
          body: payload,
        });
      } else {
        await mqttRequest("/api/mqtt/rules", {
          method: "POST",
          body: payload,
        });
      }

      setDialogOpen(false);
      setEditingRule(null);
      setStatus({
        type: "success",
        message: editingRule ? "MQTT rule updated." : "MQTT rule added.",
      });
      await loadRules();
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setSaving(false);
    }
  };

  const deleteRule = async (rule) => {
    if (!window.confirm(`Delete MQTT rule “${rule.name}”?`)) return;
    setStatus(null);
    try {
      await mqttRequest(`/api/mqtt/rules/${rule.id}`, { method: "DELETE" });
      setStatus({ type: "success", message: "MQTT rule deleted." });
      await loadRules();
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    }
  };

  const fuzzyAllowed = [
    "exact_plate",
    "any_known_plate",
    "known_name",
    "tag",
  ].includes(form.matchType);

  const valueOptions = useMemo(() => {
    if (form.matchType === "exact_plate") {
      return options.knownPlates.map((plate) => plate.plateNumber);
    }
    if (form.matchType === "known_name") return options.knownNames;
    if (form.matchType === "tag") return options.tags;
    return [];
  }, [form.matchType, options]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Rules</h2>
          <p className="text-sm text-muted-foreground">
            Choose which accepted reads publish, which cameras qualify, and
            where each message is sent.
          </p>
        </div>
        <Button onClick={openNew} disabled={options.brokers.length === 0}>
          <Plus className="mr-2 h-4 w-4" />
          Add Rule
        </Button>
      </div>

      {options.brokers.length === 0 && !loading ? (
        <StatusMessage
          status={{
            type: "info",
            message: "Add an MQTT broker before creating rules.",
          }}
        />
      ) : null}
      <StatusMessage status={status} />

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rule</TableHead>
              <TableHead>Match</TableHead>
              <TableHead>Cameras</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Fuzzy</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                </TableCell>
              </TableRow>
            ) : rules.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-40 text-center">
                  <ListFilter className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                  <div className="font-medium">No MQTT rules configured</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    MQTT remains quiet until at least one enabled rule matches.
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <div className="font-medium">{rule.name}</div>
                    <div className="text-xs text-muted-foreground">
                      Broker: {rule.brokerName}
                    </div>
                  </TableCell>
                  <TableCell>{matchDescription(rule)}</TableCell>
                  <TableCell className="max-w-[220px]">
                    {cameraDescription(rule, options.cameras)}
                  </TableCell>
                  <TableCell>
                    {rule.destinationMode === "fixed_topic" ? (
                      <code className="break-all text-xs">{rule.fixedTopic}</code>
                    ) : (
                      "Per-camera topic"
                    )}
                  </TableCell>
                  <TableCell>
                    {rule.fuzzyEnabled ? (
                      <span>
                        Distance {rule.fuzzyMaxDistance}, min {rule.fuzzyMinLength}
                      </span>
                    ) : (
                      "Off"
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={rule.enabled ? "default" : "secondary"}>
                      {rule.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit ${rule.name}`}
                            onClick={() => openEdit(rule)}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Edit rule</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete ${rule.name}`}
                            className="text-red-600 hover:text-red-700"
                            onClick={() => deleteRule(rule)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Delete rule</TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditingRule(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <form onSubmit={saveRule} className="space-y-6">
            <DialogHeader>
              <DialogTitle>
                {editingRule ? "Edit MQTT Rule" : "Add MQTT Rule"}
              </DialogTitle>
              <DialogDescription>
                Empty camera selection means any camera. Matching rules sharing
                one broker and topic are consolidated into one publish.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="mqtt-rule-name">Rule name</Label>
                <Input
                  id="mqtt-rule-name"
                  value={form.name}
                  onChange={(event) => updateForm("name", event.target.value)}
                  placeholder="Family Vehicles"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Broker</Label>
                <Select
                  value={form.brokerId}
                  onValueChange={(value) => updateForm("brokerId", value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a broker" />
                  </SelectTrigger>
                  <SelectContent>
                    {options.brokers.map((broker) => (
                      <SelectItem key={broker.id} value={String(broker.id)}>
                        {broker.name}{broker.enabled ? "" : " (disabled)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Match type</Label>
                <Select
                  value={form.matchType}
                  onValueChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      matchType: value,
                      matchValue: "",
                      fuzzyEnabled:
                        value === "any_plate" ? false : current.fuzzyEnabled,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(MATCH_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!["any_plate", "any_known_plate"].includes(form.matchType) ? (
                <div className="space-y-2">
                  <Label htmlFor="mqtt-rule-match-value">Match value</Label>
                  <Input
                    id="mqtt-rule-match-value"
                    list="mqtt-rule-values"
                    value={form.matchValue}
                    onChange={(event) =>
                      updateForm("matchValue", event.target.value)
                    }
                    placeholder={
                      form.matchType === "exact_plate"
                        ? "DPOM90"
                        : form.matchType === "known_name"
                          ? "Liz's Lexus"
                          : "Family"
                    }
                    required
                  />
                  <datalist id="mqtt-rule-values">
                    {valueOptions.map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                </div>
              ) : (
                <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                  {form.matchType === "any_plate"
                    ? "Every accepted plate read can match this rule."
                    : "Any plate found in Known Plates can match this rule."}
                </div>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Destination</Label>
                <Select
                  value={form.destinationMode}
                  onValueChange={(value) =>
                    updateForm("destinationMode", value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="per_camera">
                      Generated per-camera topic
                    </SelectItem>
                    <SelectItem value="fixed_topic">Fixed topic</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.destinationMode === "fixed_topic" ? (
                <div className="space-y-2">
                  <Label htmlFor="mqtt-rule-fixed-topic">Fixed topic</Label>
                  <Input
                    id="mqtt-rule-fixed-topic"
                    value={form.fixedTopic}
                    onChange={(event) =>
                      updateForm("fixedTopic", event.target.value)
                    }
                    placeholder="Estate/Family/Vehicles"
                    required
                  />
                </div>
              ) : (
                <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                  Each camera uses its effective topic from Cameras & Topics.
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div>
                <Label>Camera filter</Label>
                <p className="text-xs text-muted-foreground">
                  Select none for any camera, or choose one or more cameras.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {options.cameras.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No cameras have been discovered yet.
                  </div>
                ) : (
                  options.cameras.map((camera) => (
                    <label
                      key={camera.id}
                      className="flex items-center gap-2 rounded-lg border p-3"
                    >
                      <Checkbox
                        checked={form.cameraIds.includes(camera.id)}
                        onCheckedChange={(checked) =>
                          toggleCamera(camera.id, Boolean(checked))
                        }
                      />
                      <span className="text-sm">
                        {camera.cameraName}
                        {camera.enabled ? "" : " (disabled)"}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>

            {fuzzyAllowed ? (
              <div className="space-y-4 rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="mqtt-rule-fuzzy">Fuzzy OCR matching</Label>
                    <p className="text-xs text-muted-foreground">
                      Preserves the observed plate while attaching a unique
                      canonical identity when allowed.
                    </p>
                  </div>
                  <Switch
                    id="mqtt-rule-fuzzy"
                    checked={form.fuzzyEnabled}
                    onCheckedChange={(checked) =>
                      updateForm("fuzzyEnabled", checked)
                    }
                  />
                </div>

                {form.fuzzyEnabled ? (
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Maximum edit distance</Label>
                      <Select
                        value={String(form.fuzzyMaxDistance)}
                        onValueChange={(value) =>
                          updateForm("fuzzyMaxDistance", Number(value))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1">1 character</SelectItem>
                          <SelectItem value="2">2 characters</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="mqtt-rule-min-length">
                        Minimum plate length
                      </Label>
                      <Input
                        id="mqtt-rule-min-length"
                        type="number"
                        min="1"
                        max="20"
                        value={form.fuzzyMinLength}
                        onChange={(event) =>
                          updateForm("fuzzyMinLength", Number(event.target.value))
                        }
                      />
                    </div>
                    <label className="flex items-center gap-2 rounded-lg border p-3">
                      <Checkbox
                        checked={form.fuzzyRequireUnique}
                        onCheckedChange={(checked) =>
                          updateForm("fuzzyRequireUnique", Boolean(checked))
                        }
                      />
                      <span className="text-sm">Require a unique best match</span>
                    </label>
                    <label className="flex items-center gap-2 rounded-lg border p-3">
                      <Checkbox
                        checked={form.fuzzyOcrAware}
                        onCheckedChange={(checked) =>
                          updateForm("fuzzyOcrAware", Boolean(checked))
                        }
                      />
                      <span className="text-sm">Prefer common OCR confusions</span>
                    </label>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="mqtt-rule-message">Optional message</Label>
              <Textarea
                id="mqtt-rule-message"
                value={form.message}
                onChange={(event) => updateForm("message", event.target.value)}
                placeholder="Optional scalar message included in the JSON payload"
                rows={3}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div>
                <Label htmlFor="mqtt-rule-enabled">Rule enabled</Label>
                <p className="text-xs text-muted-foreground">
                  Disabled rules remain saved but cannot publish.
                </p>
              </div>
              <Switch
                id="mqtt-rule-enabled"
                checked={form.enabled}
                onCheckedChange={(checked) => updateForm("enabled", checked)}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !form.brokerId}>
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {editingRule ? "Save Rule" : "Add Rule"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      </div>
    </TooltipProvider>
  );
}
