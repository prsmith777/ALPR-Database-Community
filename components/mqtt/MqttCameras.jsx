"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, Loader2, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

import { formatMqttDate, mqttRequest } from "./api";
import { StatusMessage } from "./StatusMessage";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  baseTopic: "Blue Iris/ALPR",
  cameraTopicTemplate: "{base_topic}/{camera_key}",
  defaultQos: 1,
  retainMessages: false,
  payloadProfile: "generic_json",
  localTimezone: "America/Denver",
  hourFormat: 12,
});

export function MqttCameras() {
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
  const [cameras, setCameras] = useState([]);
  const [cameraDrafts, setCameraDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingCameraId, setSavingCameraId] = useState(null);
  const [status, setStatus] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [loadedSettings, loadedCameras] = await Promise.all([
        mqttRequest("/api/mqtt/settings"),
        mqttRequest("/api/mqtt/cameras"),
      ]);
      setSettings({ ...DEFAULT_SETTINGS, ...(loadedSettings || {}) });
      const nextCameras = Array.isArray(loadedCameras) ? loadedCameras : [];
      setCameras(nextCameras);
      setCameraDrafts(
        Object.fromEntries(
          nextCameras.map((camera) => [
            camera.id,
            {
              enabled: Boolean(camera.enabled),
              topicOverride: camera.topicOverride || "",
            },
          ])
        )
      );
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const updateSetting = (name, value) => {
    setSettings((current) => ({ ...current, [name]: value }));
  };

  const updateCameraDraft = (cameraId, name, value) => {
    setCameraDrafts((current) => ({
      ...current,
      [cameraId]: {
        ...(current[cameraId] || {}),
        [name]: value,
      },
    }));
  };

  const saveSettings = async (event) => {
    event.preventDefault();
    setSavingSettings(true);
    setStatus(null);
    try {
      await mqttRequest("/api/mqtt/settings", {
        method: "PUT",
        body: settings,
      });
      setStatus({ type: "success", message: "MQTT settings saved." });
      await loadData();
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setSavingSettings(false);
    }
  };

  const saveCamera = async (camera) => {
    setSavingCameraId(camera.id);
    setStatus(null);
    try {
      const draft = cameraDrafts[camera.id] || {
        enabled: camera.enabled,
        topicOverride: camera.topicOverride || "",
      };
      await mqttRequest(`/api/mqtt/cameras/${camera.id}`, {
        method: "PUT",
        body: draft,
      });
      setStatus({
        type: "success",
        message: `${camera.cameraName} topic settings saved.`,
      });
      await loadData();
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setSavingCameraId(null);
    }
  };

  const enabledCameraCount = useMemo(
    () => cameras.filter((camera) => camera.enabled).length,
    [cameras]
  );

  return (
    <div className="space-y-8">
      <StatusMessage status={status} />

      <Card>
        <CardHeader>
          <CardTitle>Global Topics & Payload</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveSettings} className="space-y-6">
            <div className="grid gap-5 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="mqtt-base-topic">Base topic</Label>
                <Input
                  id="mqtt-base-topic"
                  value={settings.baseTopic}
                  onChange={(event) =>
                    updateSetting("baseTopic", event.target.value)
                  }
                  placeholder="Blue Iris/ALPR"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Leading and trailing slashes are removed automatically.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mqtt-topic-template">
                  Camera topic template
                </Label>
                <Input
                  id="mqtt-topic-template"
                  value={settings.cameraTopicTemplate}
                  onChange={(event) =>
                    updateSetting("cameraTopicTemplate", event.target.value)
                  }
                  placeholder="{base_topic}/{camera_key}"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Available fields: {"{base_topic}"}, {"{camera_key}"}, and {"{camera_name}"}.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mqtt-timezone">Local timezone</Label>
                <Input
                  id="mqtt-timezone"
                  value={settings.localTimezone}
                  onChange={(event) =>
                    updateSetting("localTimezone", event.target.value)
                  }
                  placeholder="America/Denver"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Default QoS</Label>
                  <Select
                    value={String(settings.defaultQos)}
                    onValueChange={(value) =>
                      updateSetting("defaultQos", Number(value))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">0 — At most once</SelectItem>
                      <SelectItem value="1">1 — At least once</SelectItem>
                      <SelectItem value="2">2 — Exactly once</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Local time format</Label>
                  <Select
                    value={String(settings.hourFormat)}
                    onValueChange={(value) =>
                      updateSetting("hourFormat", Number(value))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="12">12-hour</SelectItem>
                      <SelectItem value="24">24-hour</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div>
                  <Label htmlFor="mqtt-enabled">MQTT publishing</Label>
                  <p className="text-xs text-muted-foreground">
                    Keep off until brokers and rules are ready.
                  </p>
                </div>
                <Switch
                  id="mqtt-enabled"
                  checked={settings.enabled}
                  onCheckedChange={(checked) =>
                    updateSetting("enabled", checked)
                  }
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div>
                  <Label htmlFor="mqtt-retain">Retained messages</Label>
                  <p className="text-xs text-muted-foreground">
                    Off is recommended for plate events.
                  </p>
                </div>
                <Switch
                  id="mqtt-retain"
                  checked={settings.retainMessages}
                  onCheckedChange={(checked) =>
                    updateSetting("retainMessages", checked)
                  }
                />
              </div>
              <div className="rounded-lg border p-4">
                <div className="text-sm font-medium">Payload profile</div>
                <div className="mt-2">
                  <Badge variant="secondary">Generic flat JSON</Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Compatible with HomeSeer, Home Assistant, and Node-RED.
                </p>
              </div>
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={savingSettings}>
                {savingSettings ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save Global Settings
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Discovered Cameras</h2>
            <p className="text-sm text-muted-foreground">
              Cameras appear automatically after an accepted plate read. Their
              stable keys do not change when display names change.
            </p>
          </div>
          <Badge variant="outline">
            {enabledCameraCount} enabled / {cameras.length} discovered
          </Badge>
        </div>

        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Camera</TableHead>
                <TableHead>Stable key</TableHead>
                <TableHead>Effective topic</TableHead>
                <TableHead>Topic override</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="text-right">Save</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                  </TableCell>
                </TableRow>
              ) : cameras.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-40 text-center">
                    <Camera className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                    <div className="font-medium">No cameras discovered yet</div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      An accepted Blue Iris plate read will create the camera
                      entry automatically.
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                cameras.map((camera) => {
                  const draft = cameraDrafts[camera.id] || {
                    enabled: camera.enabled,
                    topicOverride: camera.topicOverride || "",
                  };
                  return (
                    <TableRow key={camera.id}>
                      <TableCell>
                        <div className="font-medium">{camera.cameraName}</div>
                        <div className="text-xs text-muted-foreground">
                          Last seen: {formatMqttDate(camera.lastSeenAt) || "Never"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <code className="text-xs">{camera.cameraKey}</code>
                      </TableCell>
                      <TableCell className="max-w-[260px]">
                        {camera.topicError ? (
                          <span className="text-sm text-red-600">
                            {camera.topicError}
                          </span>
                        ) : (
                          <code className="break-all text-xs">
                            {camera.effectiveTopic}
                          </code>
                        )}
                      </TableCell>
                      <TableCell className="min-w-[240px]">
                        <Input
                          value={draft.topicOverride}
                          onChange={(event) =>
                            updateCameraDraft(
                              camera.id,
                              "topicOverride",
                              event.target.value
                            )
                          }
                          placeholder="Use generated topic"
                        />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={draft.enabled}
                          onCheckedChange={(checked) =>
                            updateCameraDraft(camera.id, "enabled", checked)
                          }
                          aria-label={`Enable ${camera.cameraName}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => saveCamera(camera)}
                            disabled={savingCameraId === camera.id}
                          >
                            {savingCameraId === camera.id ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Save className="mr-2 h-4 w-4" />
                            )}
                            Save
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
