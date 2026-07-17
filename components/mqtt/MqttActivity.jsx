"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Send, TestTube2 } from "lucide-react";

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

import { formatMqttDate, mqttRequest } from "./api";
import { StatusMessage } from "./StatusMessage";

const STATUS_VARIANTS = Object.freeze({
  pending: "secondary",
  processing: "outline",
  retry: "secondary",
  succeeded: "default",
  dead: "destructive",
});

export function MqttActivity() {
  const [brokers, setBrokers] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [settings, setSettings] = useState(null);
  const [activity, setActivity] = useState([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState(null);
  const [testForm, setTestForm] = useState({
    brokerId: "",
    cameraSelection: "generic",
    topic: "Blue Iris/ALPR/test",
    plateNumber: "TEST123",
    message: "MQTT test message",
  });

  const loadConfiguration = useCallback(async () => {
    const [loadedBrokers, loadedCameras, loadedSettings] = await Promise.all([
      mqttRequest("/api/mqtt/brokers"),
      mqttRequest("/api/mqtt/cameras"),
      mqttRequest("/api/mqtt/settings"),
    ]);

    const nextBrokers = Array.isArray(loadedBrokers) ? loadedBrokers : [];
    const nextCameras = Array.isArray(loadedCameras) ? loadedCameras : [];
    setBrokers(nextBrokers);
    setCameras(nextCameras);
    setSettings(loadedSettings || null);

    const firstBroker =
      nextBrokers.find((broker) => broker.enabled) || nextBrokers[0] || null;
    const firstCamera =
      nextCameras.find((camera) => camera.enabled) || nextCameras[0] || null;
    const fallbackTopic = `${loadedSettings?.baseTopic || "Blue Iris/ALPR"}/test`;

    setTestForm((current) => ({
      ...current,
      brokerId: current.brokerId || (firstBroker ? String(firstBroker.id) : ""),
      cameraSelection:
        current.cameraSelection !== "generic" || !firstCamera
          ? current.cameraSelection
          : String(firstCamera.id),
      topic:
        current.topic !== "Blue Iris/ALPR/test"
          ? current.topic
          : firstCamera?.effectiveTopic || fallbackTopic,
    }));
  }, []);

  const loadActivity = useCallback(async (filter = "all") => {
    const query = new URLSearchParams({ limit: "100" });
    if (filter !== "all") query.set("status", filter);
    const data = await mqttRequest(`/api/mqtt/activity?${query.toString()}`);
    setActivity(Array.isArray(data) ? data : []);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadConfiguration(), loadActivity(statusFilter)]);
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setLoading(false);
    }
  }, [loadActivity, loadConfiguration, statusFilter]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const selectedCamera = useMemo(
    () =>
      cameras.find(
        (camera) => String(camera.id) === testForm.cameraSelection
      ) || null,
    [cameras, testForm.cameraSelection]
  );

  const selectCamera = (value) => {
    const camera = cameras.find((item) => String(item.id) === value) || null;
    setTestForm((current) => ({
      ...current,
      cameraSelection: value,
      topic:
        camera?.effectiveTopic ||
        `${settings?.baseTopic || "Blue Iris/ALPR"}/test`,
    }));
  };

  const sendTest = async (event) => {
    event.preventDefault();
    setSending(true);
    setStatus(null);
    try {
      const data = await mqttRequest("/api/mqtt/test", {
        method: "POST",
        body: {
          brokerId: Number(testForm.brokerId),
          topic: testForm.topic,
          cameraName: selectedCamera?.cameraName || "MQTT Test",
          cameraKey: selectedCamera?.cameraKey || "mqtt-test",
          plateNumber: testForm.plateNumber,
          message: testForm.message,
        },
      });
      setStatus({
        type: "success",
        message: `Test queued as delivery ${data.deliveryId}. Refresh Activity to see the final broker result.`,
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await loadActivity(statusFilter);
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setSending(false);
    }
  };

  const changeStatusFilter = async (value) => {
    setStatusFilter(value);
    setLoading(true);
    try {
      await loadActivity(value);
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <StatusMessage status={status} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TestTube2 className="h-5 w-5" />
            Queue a Test Message
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={sendTest} className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-2">
                <Label>Broker</Label>
                <Select
                  value={testForm.brokerId}
                  onValueChange={(value) =>
                    setTestForm((current) => ({
                      ...current,
                      brokerId: value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select broker" />
                  </SelectTrigger>
                  <SelectContent>
                    {brokers.map((broker) => (
                      <SelectItem key={broker.id} value={String(broker.id)}>
                        {broker.name}{broker.enabled ? "" : " (disabled)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Camera identity</Label>
                <Select
                  value={testForm.cameraSelection}
                  onValueChange={selectCamera}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="generic">Generic MQTT test</SelectItem>
                    {cameras.map((camera) => (
                      <SelectItem key={camera.id} value={String(camera.id)}>
                        {camera.cameraName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mqtt-test-plate">Sample plate</Label>
                <Input
                  id="mqtt-test-plate"
                  value={testForm.plateNumber}
                  onChange={(event) =>
                    setTestForm((current) => ({
                      ...current,
                      plateNumber: event.target.value.toUpperCase(),
                    }))
                  }
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="mqtt-test-topic">Publish topic</Label>
              <Input
                id="mqtt-test-topic"
                value={testForm.topic}
                onChange={(event) =>
                  setTestForm((current) => ({
                    ...current,
                    topic: event.target.value,
                  }))
                }
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="mqtt-test-message">Message</Label>
              <Textarea
                id="mqtt-test-message"
                value={testForm.message}
                onChange={(event) =>
                  setTestForm((current) => ({
                    ...current,
                    message: event.target.value,
                  }))
                }
                rows={2}
              />
            </div>

            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={sending || !testForm.brokerId || !testForm.topic}
              >
                {sending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                Queue Test
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Delivery Activity</h2>
            <p className="text-sm text-muted-foreground">
              Recent queued, retried, successful, and dead deliveries. Passwords
              and broker credentials are never shown here.
            </p>
          </div>
          <div className="flex gap-2">
            <Select value={statusFilter} onValueChange={changeStatusFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="processing">Processing</SelectItem>
                <SelectItem value="retry">Retry</SelectItem>
                <SelectItem value="succeeded">Succeeded</SelectItem>
                <SelectItem value="dead">Dead</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={loadAll} disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Refresh
            </Button>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Camera</TableHead>
                <TableHead>Broker</TableHead>
                <TableHead>Topic</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                  </TableCell>
                </TableRow>
              ) : activity.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-40 text-center">
                    <div className="font-medium">No MQTT activity yet</div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      Queue a test or enable matching rules to create activity.
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                activity.map((delivery) => (
                  <TableRow key={delivery.id}>
                    <TableCell className="whitespace-nowrap text-sm">
                      {formatMqttDate(delivery.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={STATUS_VARIANTS[delivery.status] || "outline"}
                      >
                        {delivery.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div>{delivery.cameraName}</div>
                      <code className="text-xs text-muted-foreground">
                        {delivery.cameraKey}
                      </code>
                    </TableCell>
                    <TableCell>{delivery.brokerName}</TableCell>
                    <TableCell className="max-w-[260px]">
                      <code className="break-all text-xs">{delivery.topic}</code>
                    </TableCell>
                    <TableCell>
                      {delivery.attemptCount} / {delivery.maxAttempts}
                    </TableCell>
                    <TableCell className="max-w-[320px]">
                      <details>
                        <summary className="cursor-pointer text-sm font-medium">
                          Payload and attempts
                        </summary>
                        {delivery.lastError ? (
                          <div className="mt-2 whitespace-pre-wrap text-xs text-red-600">
                            {delivery.lastError}
                          </div>
                        ) : null}
                        <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-3 text-[11px]">
                          {JSON.stringify(
                            {
                              payload: delivery.payload,
                              attempts: delivery.attempts,
                            },
                            null,
                            2
                          )}
                        </pre>
                      </details>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
