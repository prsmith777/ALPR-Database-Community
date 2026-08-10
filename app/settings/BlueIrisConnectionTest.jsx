"use client";

import { useState, useTransition } from "react";
import { Download, FileVideo2, Images, Loader2, RefreshCw, Search, Trash2, Wifi } from "lucide-react";
import {
  checkBlueIrisExportDiagnostic,
  cleanupBlueIrisExportDiagnostic,
  createBlueIrisExportDiagnostic,
  deleteBlueIrisExportDiagnostic,
  downloadBlueIrisExportDiagnostic,
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
  const [match, setMatch] = useState(null);
  const [vehicleFrame, setVehicleFrame] = useState(null);
  const [exportDiagnostic, setExportDiagnostic] = useState(null);

  const applyExportDiagnosticResult = (result) => {
    setExportDiagnostic((previous) => {
      if (result?.success) return result;
      if (previous?.data) return { success: true, data: previous.data, error: result?.error };
      return result;
    });
  };

  const testConnection = () => {
    setConnection(null);
    setMatch(null);
    setVehicleFrame(null);
    startTransition(async () => {
      const result = await testBlueIrisConnection();
      setConnection(result);
      if (result.success && !camera && result.cameras?.length) setCamera(result.cameras[0].id);
    });
  };

  const searchAlerts = () => {
    setMatch(null);
    setVehicleFrame(null);
    const parsed = new Date(timestamp);
    if (!timestamp || Number.isNaN(parsed.getTime())) {
      setMatch({ success: false, error: "Choose the local date and time of a plate read." });
      return;
    }
    startTransition(async () => {
      setMatch(await previewBlueIrisAlertMatch({
        camera,
        timestamp: parsed.toISOString(),
        toleranceSeconds: Number(tolerance),
      }));
    });
  };

  const selectVehicleFrame = () => {
    setVehicleFrame(null);
    const selectedCamera = connection?.cameras?.find((item) => item.id === camera);
    const parsed = new Date(match?.alert?.timestamp || timestamp);
    if (Number.isNaN(parsed.getTime())) {
      setVehicleFrame({ success: false, message: "Find a matching Blue Iris alert first." });
      return;
    }
    startTransition(async () => {
      setVehicleFrame(await selectBlueIrisVehicleFrame({
        camera,
        cameraName: selectedCamera?.name || camera,
        timestamp: parsed.toISOString(),
      }));
    });
  };

  const createExportDiagnostic = () => {
    const parsed = new Date(timestamp);
    if (!timestamp || Number.isNaN(parsed.getTime())) {
      setExportDiagnostic({ success: false, error: "Choose a recorded local date and time." });
      return;
    }
    startTransition(async () => {
      applyExportDiagnosticResult(await createBlueIrisExportDiagnostic({
        camera,
        start: parsed.toISOString(),
      }));
    });
  };

  const checkExportDiagnostic = () => {
    const token = exportDiagnostic?.data?.token;
    if (!token) return;
    startTransition(async () => {
      applyExportDiagnosticResult(await checkBlueIrisExportDiagnostic({ token }));
    });
  };

  const downloadExportDiagnostic = () => {
    const token = exportDiagnostic?.data?.token;
    if (!token) return;
    startTransition(async () => {
      applyExportDiagnosticResult(await downloadBlueIrisExportDiagnostic({ token }));
    });
  };

  const deleteExportDiagnostic = () => {
    const token = exportDiagnostic?.data?.token;
    if (!token) return;
    startTransition(async () => {
      applyExportDiagnosticResult(await deleteBlueIrisExportDiagnostic({ token }));
    });
  };

  const cleanupExportDiagnostic = () => {
    const token = exportDiagnostic?.data?.token;
    if (!token) return;
    startTransition(async () => {
      applyExportDiagnosticResult(await cleanupBlueIrisExportDiagnostic({ token }));
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
              <select id="bi-test-camera" value={camera} onChange={(event) => setCamera(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                {connection.cameras.map((item) => <option key={item.id} value={item.id}>{item.name || item.id} ({item.id})</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bi-test-time">Plate-read local time</Label>
              <Input id="bi-test-time" type="datetime-local" step="1" value={timestamp} onChange={(event) => setTimestamp(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bi-test-tolerance">Tolerance (seconds)</Label>
              <Input id="bi-test-tolerance" type="number" min="1" max="900" value={tolerance} onChange={(event) => setTolerance(event.target.value)} />
            </div>
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
              <Button type="button" variant="outline" onClick={selectVehicleFrame} disabled={pending}>
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
          <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
            <div>
              <h4 className="font-medium">Manual timeline-export diagnostic</h4>
              <p className="mt-1 text-sm text-muted-foreground">
                This temporary diagnostic creates one eight-second main-stream MP4 with re-encoding disabled. Creation, one status request, download and validation, Blue Iris deletion, and staging cleanup each require a separate click. Nothing polls, downloads, or deletes automatically.
              </p>
            </div>
            {!exportDiagnostic?.data && (
              <Button type="button" variant="outline" onClick={createExportDiagnostic} disabled={pending || !camera || !timestamp}>
                {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileVideo2 className="mr-2 h-4 w-4" />}
                Create diagnostic export
              </Button>
            )}
            {exportDiagnostic?.error && (
              <p className="text-sm text-destructive">{exportDiagnostic.error}</p>
            )}
            {exportDiagnostic?.data && (
              <div className="space-y-3 rounded-md border bg-background p-3 text-sm">
                <p>
                  Status: <strong>{exportDiagnostic.data.status || "queued"}</strong>
                  {Number.isFinite(exportDiagnostic.data.progress) ? ` (${exportDiagnostic.data.progress}%)` : ""}
                </p>
                <p className="break-all text-muted-foreground">
                  Exact Blue Iris path: {exportDiagnostic.data.remotePath}
                </p>
                {!exportDiagnostic.data.deletedAt && !exportDiagnostic.data.checkedAt && (
                  <p className="font-medium text-amber-700 dark:text-amber-300">
                    Paused after creation. Inspect the Blue Iris export queue and folders, then request one status check.
                  </p>
                )}
                {!exportDiagnostic.data.deletedAt && exportDiagnostic.data.checkedAt && !exportDiagnostic.data.downloadAttemptedAt && (
                  <p className="font-medium text-amber-700 dark:text-amber-300">
                    {exportDiagnostic.data.complete || exportDiagnostic.data.status === "not_listed"
                      ? "Paused after one status request. The reserved export can now be downloaded once to staging and validated before any Blue Iris deletion."
                      : "Paused after one status request. Blue Iris still lists the export as unfinished; inspect the queue and request status again later."}
                  </p>
                )}
                {exportDiagnostic.data.downloadError && !exportDiagnostic.data.deletedAt && (
                  <p className="text-destructive">
                    Download or validation failed: {exportDiagnostic.data.downloadError} No Blue Iris delete was attempted. You may retry the explicit download.
                  </p>
                )}
                {exportDiagnostic.data.downloadValidated && !exportDiagnostic.data.deletedAt && (
                  <div className="space-y-1 font-medium text-amber-700 dark:text-amber-300">
                    <p>Paused after the exact export was downloaded to staging and validated. No Blue Iris delete has occurred.</p>
                    {exportDiagnostic.data.probe && (
                      <p>
                        Validated {exportDiagnostic.data.probe.width}x{exportDiagnostic.data.probe.height}, {(exportDiagnostic.data.probe.durationMs / 1000).toFixed(3)} seconds, {exportDiagnostic.data.probe.codec || "unknown codec"}
                        {Number.isFinite(exportDiagnostic.data.downloadBytes) ? `, ${exportDiagnostic.data.downloadBytes.toLocaleString()} bytes` : ""}.
                      </p>
                    )}
                  </div>
                )}
                {exportDiagnostic.data.deletedAt && !exportDiagnostic.data.localRemovedAt && (
                  <p className="font-medium text-green-700 dark:text-green-300">
                    Blue Iris accepted deletion of the exact diagnostic path. Paused so you can inspect the queue and folders before removing the staging temporary copy.
                  </p>
                )}
                {exportDiagnostic.data.localRemovedAt && (
                  <p className="font-medium text-green-700 dark:text-green-300">
                    Diagnostic finished. The exact Blue Iris export and the staging temporary copy were removed in separate verified phases.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {!exportDiagnostic.data.deletedAt && !exportDiagnostic.data.downloadValidated && (
                    <Button type="button" variant="outline" onClick={checkExportDiagnostic} disabled={pending}>
                      {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                      Check export status once
                    </Button>
                  )}
                  {!exportDiagnostic.data.deletedAt && !exportDiagnostic.data.downloadValidated && exportDiagnostic.data.checkedAt && (exportDiagnostic.data.complete || exportDiagnostic.data.status === "not_listed") && (
                    <Button type="button" variant="outline" onClick={downloadExportDiagnostic} disabled={pending}>
                      {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                      {exportDiagnostic.data.downloadError ? "Retry exact download and validation" : "Download and validate exact export"}
                    </Button>
                  )}
                  {!exportDiagnostic.data.deletedAt && exportDiagnostic.data.downloadValidated && (
                    <Button type="button" variant="destructive" onClick={deleteExportDiagnostic} disabled={pending}>
                      <Trash2 className="mr-2 h-4 w-4" /> Delete exact Blue Iris export
                    </Button>
                  )}
                  {exportDiagnostic.data.deletedAt && !exportDiagnostic.data.localRemovedAt && (
                    <Button type="button" variant="outline" onClick={cleanupExportDiagnostic} disabled={pending}>
                      <Trash2 className="mr-2 h-4 w-4" /> Remove staging temporary copy
                    </Button>
                  )}
                  {exportDiagnostic.data.localRemovedAt && (
                    <Button type="button" variant="outline" onClick={() => setExportDiagnostic(null)} disabled={pending}>
                      Start another diagnostic
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
