"use client";

import { useEffect, useState } from "react";
import { getVehicleImageSourceSetup, saveVehicleImageSource } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

function DirectionImageSource({ cameraName, direction, profiles, cameras, onSaved }) {
  const saved = profiles.filter((item) => item.plateCameraName === cameraName && item.directionLabel === direction)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.id - a.id)[0];
  const lprCamera = cameras.find((camera) => camera.name.toLowerCase() === cameraName.toLowerCase());
  const [draft, setDraft] = useState(() => saved || { sourceMode: "lpr_camera", sourceCameraName: cameraName,
    sourceCameraShortName: lprCamera?.id || "", expectedDeltaMs: 0, toleranceMs: 1500, enabled: true });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const prefix = `image-source-${direction.replace(/[^a-z0-9]/gi, "-")}`;
  async function save() {
    setBusy(true); setMessage("");
    try {
      const result = await saveVehicleImageSource({ ...draft, plateCameraName: cameraName, directionLabel: direction });
      if (!result.success) throw new Error(result.error);
      setDraft(result.data);
      await onSaved();
      setMessage(`Saved for ${direction}. New eligible plate reads will use this source.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  return <div className="space-y-4 rounded-lg border p-4">
    <h3 className="font-medium">{direction}</h3>
    <p className="text-sm text-muted-foreground" role="status">
      {!saved ? "Not saved yet. Choose a source and save this direction below."
        : ["sourceMode", "sourceCameraName", "sourceCameraShortName", "expectedDeltaMs", "toleranceMs", "enabled"]
          .some((key) => draft[key] !== saved[key]) ? "Unsaved changes. Save this direction to apply them."
          : saved.enabled ? "Saved and enabled for new eligible reads." : "Saved with this image source disabled."}
    </p>
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-mode`}>Vehicle image source</Label>
        <Select value={draft.sourceMode} disabled={busy} onValueChange={(sourceMode) => setDraft({ ...draft, sourceMode,
          sourceCameraName: sourceMode === "lpr_camera" ? cameraName : "",
          sourceCameraShortName: sourceMode === "lpr_camera" ? lprCamera?.id || "" : "", expectedDeltaMs: 0 })}>
          <SelectTrigger id={`${prefix}-mode`}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="lpr_camera">This LPR camera</SelectItem><SelectItem value="overview">Overview camera</SelectItem></SelectContent>
        </Select>
      </div>
      {draft.sourceMode === "overview" ? <div className="space-y-2">
        <Label htmlFor={`${prefix}-camera`}>Overview camera</Label>
        <Select value={draft.sourceCameraShortName || ""} disabled={busy} onValueChange={(id) => {
          const selected = cameras.find((camera) => camera.id === id);
          setDraft({ ...draft, sourceCameraShortName: id, sourceCameraName: selected?.name || "" });
        }}><SelectTrigger id={`${prefix}-camera`}><SelectValue placeholder="Choose a Blue Iris camera" /></SelectTrigger>
          <SelectContent>{cameras.filter((camera) => camera.name.toLowerCase() !== cameraName.toLowerCase())
            .map((camera) => <SelectItem key={camera.id} value={camera.id}>{camera.name} ({camera.id})</SelectItem>)}</SelectContent>
        </Select>
      </div> : <p className="self-end text-sm text-muted-foreground">
        Uses recordings from {cameraName}. The view must show the whole vehicle, rather than just the plate.
      </p>}
      {draft.sourceMode === "overview" ? <div className="space-y-2">
        <Label htmlFor={`${prefix}-offset`}>Timing offset (seconds)</Label>
        <Input id={`${prefix}-offset`} type="number" min="-30" max="30" step="0.1" disabled={busy}
          value={draft.expectedDeltaMs / 1000} onChange={(event) => setDraft({ ...draft, expectedDeltaMs: Number(event.target.value) * 1000 })} />
        <p className="text-xs text-muted-foreground">Use a positive value if the vehicle reaches this camera after the plate read.</p>
      </div> : null}
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-tolerance`}>Timing tolerance (seconds)</Label>
        <Input id={`${prefix}-tolerance`} type="number" min="0.25" max="3" step="0.25" disabled={busy}
          aria-describedby={`${prefix}-tolerance-help`} value={draft.toleranceMs / 1000}
          onChange={(event) => setDraft({ ...draft, toleranceMs: Math.round(Number(event.target.value) * 1000) })} />
        <p id={`${prefix}-tolerance-help`} className="text-xs text-muted-foreground">
          Search this many seconds before and after the offset time. Choose 0.25 to 3 seconds.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <Label htmlFor={`${prefix}-enabled`}>Use this image source</Label>
        <Switch id={`${prefix}-enabled`} checked={draft.enabled} disabled={busy} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
      </div>
    </div>
    <Button onClick={save} disabled={busy || !cameras.length}>{busy ? "Saving…" : `Save image source for ${direction}`}</Button>
    {message ? <p role="status" className="text-sm">{message}</p> : null}
  </div>;
}

export default function VehicleImageSourceSettings({ profile }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    getVehicleImageSourceSetup().then((result) => {
      if (!active) return;
      if (result.success) setData(result.data); else setError(result.error);
    }).catch(() => { if (active) setError("Unable to load vehicle image setup."); });
    return () => { active = false; };
  }, []);
  async function reload() {
    const result = await getVehicleImageSourceSetup();
    if (!result.success) throw new Error(result.error);
    setData(result.data);
  }
  const directions = [...new Set([profile.frontDirectionLabel, profile.rearDirectionLabel].filter(Boolean))];
  return <Card className="mt-5">
    <CardHeader><CardTitle>Vehicle images for ReID</CardTitle><CardDescription>
      Choose where ALPR gets whole-vehicle images for each saved direction. The same setup works on Windows and Linux.
    </CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">Blue Iris must record the selected camera. ALPR checks the recorded frames near each new plate read
        and rejects incomplete, ambiguous, or monochrome night views. A plate thumbnail alone cannot produce a reliable ReID match.</p>
      {error ? <p role="status">{error}</p> : !data ? <p>Loading image setup…</p> : !directions.length
        ? <p>Save your camera direction labels above first.</p> : <>
          {!data.cameras.length ? <p>Open Blue Iris settings and click Test connection to load your camera list, then return here.</p> : null}
          {directions.map((direction) => <DirectionImageSource key={`${profile.cameraName}:${direction}`} cameraName={profile.cameraName}
            direction={direction} profiles={data.profiles} cameras={data.cameras} onSaved={reload} />)}
        </>}
    </CardContent>
  </Card>;
}
