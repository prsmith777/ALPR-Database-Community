"use client";

import { useCallback, useEffect, useState } from "react";
import { Edit, Loader2, Plus, Trash2, Wifi } from "lucide-react";

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
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { mqttRequest } from "./api";
import { StatusMessage } from "./StatusMessage";

const EMPTY_FORM = Object.freeze({
  name: "",
  broker: "",
  port: 1883,
  username: "",
  password: "",
  useTls: false,
  clientId: "alpr-dashboard",
  enabled: true,
  clearPassword: false,
});

function makeEmptyForm() {
  return { ...EMPTY_FORM };
}

export function MqttBrokers() {
  const [brokers, setBrokers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBroker, setEditingBroker] = useState(null);
  const [form, setForm] = useState(makeEmptyForm);

  const loadBrokers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await mqttRequest("/api/mqtt/brokers");
      setBrokers(Array.isArray(data) ? data : []);
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBrokers();
  }, [loadBrokers]);

  const openNew = () => {
    setEditingBroker(null);
    setForm(makeEmptyForm());
    setDialogOpen(true);
  };

  const openEdit = (broker) => {
    setEditingBroker(broker);
    setForm({
      name: broker.name || "",
      broker: broker.broker || "",
      port: broker.port || 1883,
      username: broker.username || "",
      password: "",
      useTls: Boolean(broker.useTls),
      clientId: broker.clientId || "",
      enabled: Boolean(broker.enabled),
      clearPassword: false,
    });
    setDialogOpen(true);
  };

  const updateForm = (name, value) => {
    setForm((current) => ({ ...current, [name]: value }));
  };

  const saveBroker = async (event) => {
    event.preventDefault();
    setSaving(true);
    setStatus(null);

    try {
      const payload = {
        name: form.name,
        broker: form.broker,
        port: Number(form.port),
        username: form.username,
        useTls: form.useTls,
        clientId: form.clientId,
        enabled: form.enabled,
      };

      if (form.password) payload.password = form.password;
      if (editingBroker && form.clearPassword) payload.clearPassword = true;

      if (editingBroker) {
        await mqttRequest(`/api/mqtt/brokers/${editingBroker.id}`, {
          method: "PUT",
          body: payload,
        });
      } else {
        await mqttRequest("/api/mqtt/brokers", {
          method: "POST",
          body: payload,
        });
      }

      setDialogOpen(false);
      setEditingBroker(null);
      setForm(makeEmptyForm());
      setStatus({
        type: "success",
        message: editingBroker
          ? "MQTT broker updated."
          : "MQTT broker added.",
      });
      await loadBrokers();
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setSaving(false);
    }
  };

  const deleteBroker = async (broker) => {
    const confirmed = window.confirm(
      `Delete MQTT broker “${broker.name}”? Rules or activity that reference it may prevent deletion.`
    );
    if (!confirmed) return;

    setStatus(null);
    try {
      await mqttRequest(`/api/mqtt/brokers/${broker.id}`, {
        method: "DELETE",
      });
      setStatus({ type: "success", message: "MQTT broker deleted." });
      await loadBrokers();
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Brokers</h2>
          <p className="text-sm text-muted-foreground">
            Broker connections are reusable. Topics are configured globally,
            per camera, or on individual rules.
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" />
          Add Broker
        </Button>
      </div>

      <StatusMessage status={status} />

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>Authentication</TableHead>
              <TableHead>TLS</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                </TableCell>
              </TableRow>
            ) : brokers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-40 text-center">
                  <Wifi className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                  <div className="font-medium">No MQTT brokers configured</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    Add the broker used by HomeSeer, Home Assistant, or another
                    MQTT consumer.
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              brokers.map((broker) => (
                <TableRow key={broker.id}>
                  <TableCell className="font-medium">
                    <div>{broker.name}</div>
                    {broker.clientId ? (
                      <div className="text-xs text-muted-foreground">
                        Client ID: {broker.clientId}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">
                      {broker.broker}:{broker.port}
                    </code>
                  </TableCell>
                  <TableCell>
                    <div>{broker.username || "Anonymous"}</div>
                    <div className="text-xs text-muted-foreground">
                      {broker.hasPassword
                        ? "Stored password"
                        : "No stored password"}
                    </div>
                  </TableCell>
                  <TableCell>{broker.useTls ? "Enabled" : "Off"}</TableCell>
                  <TableCell>
                    <Badge variant={broker.enabled ? "default" : "secondary"}>
                      {broker.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit ${broker.name}`}
                            onClick={() => openEdit(broker)}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Edit broker</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete ${broker.name}`}
                            className="text-red-600 hover:text-red-700"
                            onClick={() => deleteBroker(broker)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Delete broker</TooltipContent>
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
          if (!open) {
            setEditingBroker(null);
            setForm(makeEmptyForm());
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto">
          <form onSubmit={saveBroker} className="space-y-5">
            <DialogHeader>
              <DialogTitle>
                {editingBroker ? "Edit MQTT Broker" : "Add MQTT Broker"}
              </DialogTitle>
              <DialogDescription>
                Leaving the password blank while editing preserves the existing
                stored password.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="mqtt-broker-name">Name</Label>
                <Input
                  id="mqtt-broker-name"
                  value={form.name}
                  onChange={(event) => updateForm("name", event.target.value)}
                  placeholder="Home MQTT"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mqtt-broker-host">Host or IP address</Label>
                <Input
                  id="mqtt-broker-host"
                  value={form.broker}
                  onChange={(event) => updateForm("broker", event.target.value)}
                  placeholder="192.168.0.97"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mqtt-broker-port">Port</Label>
                <Input
                  id="mqtt-broker-port"
                  type="number"
                  min="1"
                  max="65535"
                  value={form.port}
                  onChange={(event) => updateForm("port", event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mqtt-broker-username">Username</Label>
                <Input
                  id="mqtt-broker-username"
                  value={form.username}
                  onChange={(event) =>
                    updateForm("username", event.target.value)
                  }
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mqtt-broker-password">
                  {editingBroker ? "New password" : "Password"}
                </Label>
                <PasswordInput
                  id="mqtt-broker-password"
                  visibilityLabel="broker password"
                  value={form.password}
                  onChange={(event) =>
                    updateForm("password", event.target.value)
                  }
                  autoComplete="new-password"
                  placeholder={
                    editingBroker && editingBroker.hasPassword
                      ? "Leave blank to keep stored password"
                      : "Optional"
                  }
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="mqtt-broker-client-id">Client ID</Label>
                <Input
                  id="mqtt-broker-client-id"
                  value={form.clientId}
                  onChange={(event) =>
                    updateForm("clientId", event.target.value)
                  }
                  placeholder="alpr-dashboard"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label htmlFor="mqtt-broker-enabled">Enabled</Label>
                  <p className="text-xs text-muted-foreground">
                    Disabled brokers do not publish.
                  </p>
                </div>
                <Switch
                  id="mqtt-broker-enabled"
                  checked={form.enabled}
                  onCheckedChange={(checked) =>
                    updateForm("enabled", checked)
                  }
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label htmlFor="mqtt-broker-tls">TLS</Label>
                  <p className="text-xs text-muted-foreground">
                    Use an encrypted broker connection.
                  </p>
                </div>
                <Switch
                  id="mqtt-broker-tls"
                  checked={form.useTls}
                  onCheckedChange={(checked) => updateForm("useTls", checked)}
                />
              </div>
            </div>

            {editingBroker?.hasPassword ? (
              <div className="flex items-center gap-2 rounded-lg border p-3">
                <Checkbox
                  id="mqtt-clear-password"
                  checked={form.clearPassword}
                  onCheckedChange={(checked) =>
                    updateForm("clearPassword", Boolean(checked))
                  }
                />
                <Label htmlFor="mqtt-clear-password">
                  Remove the currently stored password
                </Label>
              </div>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {editingBroker ? "Save Broker" : "Add Broker"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      </div>
    </TooltipProvider>
  );
}
