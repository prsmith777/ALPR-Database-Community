"use client";

import { useState } from "react";
import Image from "next/image";
import { getVehicleDirectionSetup, labelVehicleOrientation } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function VehicleDirectionTraining({ profile }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState({});
  async function load() {
    const result = await getVehicleDirectionSetup(profile.cameraName, {
      includeCaptures: true, includeBackfill: false, includeBlueIrisTriggerDirection: false });
    if (!result.success) throw new Error(result.error);
    setData(result.data);
  }
  async function run(capture, orientation) {
    setBusy(true); setMessage("");
    try {
      if (capture) {
        const result = await labelVehicleOrientation({ readId: capture.readId,
          sourceEmbeddingId: capture.sourceEmbeddingId, orientation });
        if (!result.success) throw new Error(result.error);
        setMessage("Front/rear example saved.");
      }
      await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  const current = data?.profiles.find((item) => item.cameraName === profile.cameraName) || profile;
  return <Card className="mt-5">
    <CardHeader><CardTitle>Front/rear direction training</CardTitle><CardDescription>
      Optional local ReID fallback for {profile.cameraName}. Mapped Blue Iris crossings retain priority.
    </CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm">Label at least three clear front crops and three rear crops from several vehicles.
        Use the whole vehicle in color. Ambiguous, obstructed, and monochrome nighttime views are unsuitable.</p>
      <p className="text-sm">Examples: {current.frontCount} front · {current.rearCount} rear.
        Front means {current.frontDirectionLabel || "not configured"}; rear means {current.rearDirectionLabel || "not configured"}.</p>
      <Button variant="outline" disabled={busy} onClick={() => run()}>
        {busy ? "Loading…" : data ? "Refresh training examples" : "Load training examples"}
      </Button>
      {message ? <p role="status">{message}</p> : null}
      {data && !data.captures.length ? <p className="text-sm text-muted-foreground">
        No eligible vehicle crops yet. Check recorded image sources and vehicle processing first.
      </p> : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.captures.map((capture) => <article key={capture.sourceEmbeddingId} className="min-w-0 space-y-2 rounded-lg border p-3">
          <Image src={capture.imageUrl} alt={`Training vehicle crop for read ${capture.readId}`}
            width={640} height={400} unoptimized className="h-48 w-full object-contain"
            onLoad={() => setLoaded((state) => ({ ...state, [capture.sourceEmbeddingId]: true }))}
            onError={() => setLoaded((state) => ({ ...state, [capture.sourceEmbeddingId]: false }))} />
          {loaded[capture.sourceEmbeddingId] === false ? <p role="alert">Crop unavailable. Refresh before labeling.</p> : null}
          <p className="text-sm">Read {capture.readId} · Label: {capture.orientation || "Not labeled"}</p>
          <div className="flex gap-2">
            {["front", "rear"].map((orientation) => <Button key={orientation} variant="outline"
              disabled={busy || !current.configured || !capture.sourceEmbeddingId || loaded[capture.sourceEmbeddingId] !== true}
              onClick={() => run(capture, orientation)}>{orientation === "front" ? "Front view" : "Rear view"}</Button>)}
          </div>
        </article>)}
      </div>
    </CardContent>
  </Card>;
}
