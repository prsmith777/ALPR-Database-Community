"use client";

import { useState, useTransition } from "react";
import { Images, Loader2, Search, Wifi } from "lucide-react";
import {
  previewBlueIrisAlertMatch,
  selectBlueIrisVehicleFrame,
  testBlueIrisConnection,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function BlueIrisConnectionTest() {
  const [pending, startTransition] = useTransition();
  const [connection, setConnection] = useState(null);
  const [camera, setCamera] = useState("");
  const [timestamp, setTimestamp] = useState("");
  const [tolerance, setTolerance] = useState("90");
  const [readTolerance, setReadTolerance] = useState("3");
  const [readId, setReadId] = useState("");
  const [match, setMatch] = useState(null);
  const [vehicleFrame, setVehicleFrame] = useState(null);

  const testConnection = () => {
    setConnection(null);
    setMatch(null);
    setReadId("");
    setVehicleFrame(null);
    startTransition(async () => {
      const result = await testBlueIrisConnection();
      setConnection(result);
      if (result.success && !camera && result.cameras?.length) setCamera(result.cameras[0].id);
    });
  };

  const searchAlerts = () => {
    setMatch(null);
    setReadId("");
    setVehicleFrame(null);
    const parsed = new Date(timestamp);
    if (!timestamp || Number.isNaN(parsed.getTime())) {
      setMatch({ success: false, error: "Choose the local date and time of a plate read." });
      return;
    }
    startTransition(async () => {
      const result = await previewBlueIrisAlertMatch({
        camera,
        timestamp: parsed.toISOString(),
        toleranceSeconds: Number(tolerance),
        readToleranceSeconds: Number(readTolerance),
      });
      setMatch({ ...result, readTimestamp: parsed.toISOString() });
      if (result.reads?.length === 1) setReadId(String(result.reads[0].id));
    });
  };

  const selectVehicleFrame = () => {
    setVehicleFrame(null);
    const selectedCamera = connection?.cameras?.find((item) => item.id === camera);
    const parsed = new Date(match?.readTimestamp || timestamp);
    if (Number.isNaN(parsed.getTime())) {
      setVehicleFrame({ success: false, message: "Find a matching Blue Iris alert first." });
      return;
    }
    startTransition(async () => {
      setVehicleFrame(await selectBlueIrisVehicleFrame({
        camera,
        cameraName: selectedCamera?.name || camera,
        timestamp: parsed.toISOString(),
        readId: Number(readId),
        readToleranceSeconds: match.readToleranceSeconds,
      }));
    });
  };

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div>
        <h3 className="font-medium">Read-only connection test</h3>
        <p className="text-sm text-muted-foreground">
          Save changes first. This lists cameras, searches alert metadata, and samples a bounded recording window; it never changes or deletes Blue Iris recordings.
        </p>
      </div>
      <Button type="button" variant="outline" onClick={testConnection} disabled={pending}>
        {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wifi className="mr-2 h-4 w-4" />}
        Test connection
      </Button>
      {connection && !connection.success && <p className="text-sm text-destructive">{connection.error}</p>}
      {connection?.success && (
        <div className="space-y-4 rounded-md bg-muted/40 p-4">
          <p className="text-sm">
            Connected{connection.systemName ? ` to ${connection.systemName}` : ""}
            {connection.version ? ` (Blue Iris ${connection.version})` : ""}. Found {connection.cameraCount} cameras.
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="bi-test-camera">Blue Iris camera</Label>
              <select id="bi-test-camera" disabled={pending} value={camera} onChange={(event) => { setCamera(event.target.value); setMatch(null); setVehicleFrame(null); }} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                {connection.cameras.map((item) => <option key={item.id} value={item.id}>{item.name || item.id} ({item.id})</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bi-test-time">Plate-read local time</Label>
              <Input id="bi-test-time" disabled={pending} type="datetime-local" step="1" value={timestamp} onChange={(event) => { setTimestamp(event.target.value); setMatch(null); setVehicleFrame(null); }} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bi-test-tolerance">Blue Iris alert tolerance (seconds)</Label>
              <Input id="bi-test-tolerance" disabled={pending} type="number" min="1" max="900" value={tolerance} onChange={(event) => { setTolerance(event.target.value); setMatch(null); setVehicleFrame(null); }} />
            </div>
            <div className="space-y-2"><Label htmlFor="bi-read-tolerance">ALPR read tolerance (seconds)</Label><Input id="bi-read-tolerance" disabled={pending} type="number" min="1" max="30" value={readTolerance} onChange={event => { setReadTolerance(event.target.value); setMatch(null); setVehicleFrame(null); }} /></div>
          </div>
          <Button type="button" variant="outline" onClick={searchAlerts} disabled={pending || !camera}>
            <Search className="mr-2 h-4 w-4" /> Find matching alert
          </Button>
          {match && !match.success && <p className="text-sm text-destructive">{match.error}</p>}
          {match?.success && !match.matched && (
            <p className="text-sm text-muted-foreground">No alert matched within the selected window ({match.searchedCount} candidates searched).</p>
          )}
          {match?.success && match.matched && (
            <div className="space-y-3 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm">
              <div>
                Matched {match.alert.camera || camera} at {new Date(match.alert.timestamp).toLocaleString()}
                {Number.isFinite(match.alert.deltaSeconds) ? ` (${match.alert.deltaSeconds.toFixed(1)} seconds away)` : ""}.
                {(match.alert.clip || match.alert.file) && (
                  <span className="block break-all text-muted-foreground">
                    Recording: {match.alert.clip || match.alert.file}
                    {match.alert.offset !== null ? ` · offset ${match.alert.offset}` : ""}
                  </span>
                )}
              </div>
              {match.reads?.length ? <div className="space-y-2"><Label htmlFor="bi-matched-read">ALPR read that will own this image</Label><select id="bi-matched-read" disabled={pending} className="h-10 w-full rounded-md border bg-background px-3" value={readId} onChange={event => { setReadId(event.target.value); setVehicleFrame(null); }}><option value="">Choose the correct ALPR read</option>{match.reads.map(read => <option key={read.id} value={read.id}>#{read.id} · {read.plateNumber} · {read.cameraName} · {new Date(read.timestamp).toLocaleString()}</option>)}</select></div> : <p>No ALPR read matched this camera within {match.readToleranceSeconds} seconds of the entered plate-read time. Check its camera binding and the time shown in Recognition Feed.</p>}
              <Button type="button" variant="outline" onClick={selectVehicleFrame} disabled={pending || !readId}>
                {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Images className="mr-2 h-4 w-4" />}
                Select best vehicle frame
              </Button>
            </div>
          )}
          {vehicleFrame?.success && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <p>Saved the best of {vehicleFrame.sampledCount} bounded samples for read #{vehicleFrame.readId}{vehicleFrame.plateNumber ? ` (${vehicleFrame.plateNumber})` : ""}.</p>
              <p className="text-muted-foreground">Vehicle detected in {vehicleFrame.detectedCount} samples; selected {new Date(vehicleFrame.frameTimestamp).toLocaleString()}.</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={vehicleFrame.imageUrl} alt={`Selected Blue Iris vehicle view for ${vehicleFrame.plateNumber || "the matched read"}`} className="max-h-80 w-full rounded-md border bg-black object-contain" />
            </div>
          )}
          {vehicleFrame && !vehicleFrame.success && (
            <p className="text-sm text-destructive">{vehicleFrame.message || "Unable to select a Blue Iris vehicle frame."}</p>
          )}
        </div>
      )}
    </div>
  );
}
