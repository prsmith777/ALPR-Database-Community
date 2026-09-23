"use client";

import { useEffect, useMemo, useState } from "react";
import { BrainCircuit, Loader2, Save, Settings2 } from "lucide-react";

import {
  getVehicleDirectionSetup,
  saveVehicleDirectionProfile,
} from "@/app/actions";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

function statusText(profile, minimum) {
  if (!profile?.configured) return "Needs direction meanings";
  if (profile.frontCount < minimum || profile.rearCount < minimum) return "Collecting examples";
  return profile.enabled ? "Ready to classify" : "Paused";
}

export default function VehicleIntelligenceSettings({ initialData }) {
  const [data, setData] = useState(initialData);
  const [cameraName, setCameraName] = useState(initialData.selectedCamera || "");
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const profile = useMemo(
    () => data.profiles.find((item) => item.cameraName === cameraName) || data.profiles[0] || null,
    [cameraName, data.profiles]
  );

  useEffect(() => {
    if (profile) setDraft({ ...profile });
  }, [profile]);

  async function reload(selectedCamera = cameraName) {
    const result = await getVehicleDirectionSetup(selectedCamera, {
      includeBackfill: false,
      includeCaptures: false,
      includeBlueIrisTriggerDirection: true,
    });
    if (!result.success) throw new Error(result.error);
    setData(result.data);
    setCameraName(result.data.selectedCamera || selectedCamera);
  }

  async function selectCamera(value) {
    setCameraName(value);
    setBusy("loading");
    setMessage("");
    try {
      await reload(value);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  }

  async function saveProfile() {
    setBusy("saving");
    setMessage("");
    try {
      const result = await saveVehicleDirectionProfile(draft);
      if (!result.success) throw new Error(result.error);
      await reload(cameraName);
      setMessage("Camera direction setup saved.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <SettingsShell
      activeId="vehicleIntelligence"
      title="Vehicle Setup"
      description="Configure portable direction behavior for each camera observed by the Community application."
    >
      {message ? <p className="mb-5 rounded-md border p-3 text-sm" role="status">{message}</p> : null}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BrainCircuit className="h-5 w-5" /> Camera direction setup
          </CardTitle>
          <CardDescription>
            Map Blue Iris ordered zone crossings to semantic directions. Values
            are supplied by your own camera configuration; no fixed camera names
            or installation-specific routes are included.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!profile ? (
            <p className="text-sm text-muted-foreground">
              No cameras with plate reads are available yet. Ingest a read, then return here.
            </p>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                <div className="space-y-2">
                  <Label>Camera</Label>
                  <Select value={cameraName} onValueChange={selectCamera} disabled={Boolean(busy)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {data.profiles.map((item) => (
                        <SelectItem key={item.cameraName} value={item.cameraName}>
                          {item.cameraName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Badge variant="outline" className="h-9 justify-center px-3">
                  {statusText(profile, data.minimumSamplesPerView)}
                </Badge>
              </div>

              {draft ? (
                <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="front-direction">Front-view direction label</Label>
                    <Input
                      id="front-direction"
                      value={draft.frontDirectionLabel}
                      onChange={(event) => setDraft({ ...draft, frontDirectionLabel: event.target.value })}
                      placeholder="Example: Eastbound"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rear-direction">Rear-view direction label</Label>
                    <Input
                      id="rear-direction"
                      value={draft.rearDirectionLabel}
                      onChange={(event) => setDraft({ ...draft, rearDirectionLabel: event.target.value })}
                      placeholder="Example: Westbound"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="direction-confidence">
                      Minimum confidence ({Math.round(draft.minimumConfidence * 100)}%)
                    </Label>
                    <input
                      id="direction-confidence"
                      type="range"
                      min="50"
                      max="95"
                      step="1"
                      value={Math.round(draft.minimumConfidence * 100)}
                      onChange={(event) => setDraft({ ...draft, minimumConfidence: Number(event.target.value) / 100 })}
                      className="w-full accent-primary"
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-md border px-3 py-2">
                    <div>
                      <div className="text-sm font-medium">Direction classification</div>
                      <div className="text-xs text-muted-foreground">Pause without deleting configuration.</div>
                    </div>
                    <Switch
                      checked={draft.enabled}
                      onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
                    />
                  </div>
                  <div className="space-y-4 rounded-md border p-4 md:col-span-2">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Settings2 className="h-4 w-4" /> Blue Iris zone-crossing direction
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Configure both ordered crossings in Blue Iris, such as A&gt;B and B&gt;A.
                        </div>
                      </div>
                      <Switch
                        checked={draft.blueIrisMotionEnabled === true}
                        onCheckedChange={(blueIrisMotionEnabled) => setDraft({ ...draft, blueIrisMotionEnabled })}
                        aria-label="Enable Blue Iris zone-crossing direction"
                      />
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="blue-iris-front-trigger">
                          Trigger for {draft.frontDirectionLabel || "front-view direction"}
                        </Label>
                        <Input
                          id="blue-iris-front-trigger"
                          value={draft.blueIrisFrontTriggerType || ""}
                          onChange={(event) => setDraft({ ...draft, blueIrisFrontTriggerType: event.target.value })}
                          placeholder="MOTION_A>B"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="blue-iris-rear-trigger">
                          Trigger for {draft.rearDirectionLabel || "rear-view direction"}
                        </Label>
                        <Input
                          id="blue-iris-rear-trigger"
                          value={draft.blueIrisRearTriggerType || ""}
                          onChange={(event) => setDraft({ ...draft, blueIrisRearTriggerType: event.target.value })}
                          placeholder="MOTION_B>A"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <Button onClick={saveProfile} disabled={Boolean(busy)}>
                      {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                      Save camera setup
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </SettingsShell>
  );
}
