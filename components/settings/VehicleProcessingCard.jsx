"use client";

import { useEffect, useState } from "react";
import { getBlueIrisVehicleFrameQueueStatus, getVehicleAnalysisStatus, operateVehicleAnalysis } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function VehicleProcessingCard() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [frames, setFrames] = useState(null);
  const [frameError, setFrameError] = useState("");
  const [message, setMessage] = useState("");

  async function refreshFrames() {
    const result = await getBlueIrisVehicleFrameQueueStatus();
    if (result.success) { setFrames(result.data); setFrameError(""); }
    else setFrameError(result.error);
  }
  useEffect(() => {
    let active = true;
    getBlueIrisVehicleFrameQueueStatus().then((result) => {
      if (!active) return;
      if (result.success) setFrames(result.data); else setFrameError(result.error);
    }).catch(() => { if (active) setFrameError("Unable to load recorded frame retrieval status."); });
    return () => { active = false; };
  }, []);
  async function refresh() {
    const result = await getVehicleAnalysisStatus();
    if (!result.success) throw new Error(result.error);
    setData(result.data);
  }
  useEffect(() => {
    let active = true;
    getVehicleAnalysisStatus().then((result) => {
      if (!active) return;
      if (result.success) setData(result.data);
      else setMessage(result.error);
    }).catch(() => {
      if (active) setMessage("Unable to load vehicle processing status.");
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  async function run(operation) {
    setBusy(true);
    setMessage("");
    try {
      if (operation !== "refresh") {
        const result = await operateVehicleAnalysis(operation);
        if (!result.success) throw new Error(result.error);
        setMessage(operation === "retry"
          ? `Queued ${result.changed} failed jobs for another attempt.`
          : operation === "pause" ? "New image work paused; in-flight work can finish."
            : "Automatic image processing resumed.");
      }
      await Promise.all([refresh(), refreshFrames()]);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Vehicle processing · ReID V2</CardTitle>
        <CardDescription>
          Whole-vehicle images are cataloged, cropped, and analyzed automatically in the background.
          Search and profiles appear as processing completes. Plate-only images and display fallbacks
          are not identity evidence. Original images are never replaced.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data ? (
          <>
            <p role="status">{data.enabled ? "Automatic image processing is on." : "New image processing is paused."}</p>
            <p className="text-sm text-muted-foreground">
              Crop analysis: {data.pending} queued · {data.processing} processing · {data.ready} complete · {data.failed} failed.
              These counts start after a usable crop is available; no images or no eligible sources can mean all counts are zero.
            </p>
          </>
        ) : <p>{busy ? "Loading processing status…" : "Status unavailable."}</p>}
        <div className="space-y-3 rounded-lg border p-3 text-sm">
          <h3 className="font-medium">Recorded vehicle frame retrieval</h3>
          <p className="text-muted-foreground">This stage runs before crop analysis. Refresh status to check both stages.</p>
          {frames?.overview ? <>
            <p>{frames.configured ? "Blue Iris is configured." : "Complete the Blue Iris connection settings first."}</p>
            <p>{frames.overview.pending} queued · {frames.overview.processing} processing · {frames.overview.ready} ready · {frames.overview.ambiguous} ambiguous · {frames.overview.unavailable} unavailable · {frames.overview.nighttimeSkipped} nighttime skipped · {frames.overview.failed} failed.</p>
            <p className="text-muted-foreground">Blue Iris exports: {frames.overview.exports.active} active · {frames.overview.exports.downloaded} downloaded · {frames.overview.exports.failed} failed.</p>
            <div className="overflow-x-auto"><table className="w-full text-left">
              <thead><tr><th className="p-2">Read</th><th className="p-2">Camera</th><th className="p-2">Frame status</th><th className="p-2">Reason</th></tr></thead>
              <tbody>{frames.overview.recentJobs.slice(0, 10).map((job) => <tr key={job.readId}>
                <td className="p-2">{job.readId}</td><td className="p-2">{job.cameraName}</td>
                <td className="p-2">{job.readStatus}</td><td className="p-2">{job.readErrorCode || job.exportErrorCode || "—"}</td>
              </tr>)}</tbody>
            </table></div>
          </> : <p>{frameError || "Loading recorded frame status…"}</p>}
          {frames && frameError ? <p role="status">{frameError}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => run("refresh")}>Refresh status</Button>
          <Button variant="outline" disabled={busy || !data} onClick={() => run(data.enabled ? "pause" : "resume")}>
            {data?.enabled ? "Pause image processing" : "Resume image processing"}
          </Button>
          <Button variant="outline" disabled={busy || !data?.failed} onClick={() => run("retry")}>Retry failed jobs (up to 100)</Button>
        </div>
        {message ? <p role="status" className="text-sm">{message}</p> : null}
      </CardContent>
    </Card>
  );
}

