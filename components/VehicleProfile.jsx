"use client";

import NextImage from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, ExternalLink, ListChecks, Loader2, ShieldCheck, Tags, XCircle } from "lucide-react";

import { getVehicleProfile, reviewVehicleDistinctiveFeatures, reviewVehiclePlateAssociation } from "@/app/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

function when(value) {
  return value ? new Date(value).toLocaleString() : "Unknown";
}

function percent(value) {
  return value === null || value === undefined ? "Not scored" : `${Math.round(value * 100)}%`;
}

function AssociationDecision({ association, busy, onReview, showConfirm = true, showReject = true }) {
  const confirmKey = `${association.plateNumber}:confirm`;
  const rejectKey = `${association.plateNumber}:reject`;
  return (
    <div className={`grid gap-2 ${showConfirm && showReject ? "sm:grid-cols-2" : ""}`}>
      {showConfirm && <AlertDialog>
        <AlertDialogTrigger asChild><Button disabled={Boolean(busy)}><CheckCircle2 className="mr-2 h-4 w-4" />Confirm association</Button></AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Associate this vehicle with {association.plateNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              This creates a trusted plate-to-vehicle baseline from {association.evidenceCount} human-confirmed cluster {association.evidenceCount === 1 ? "capture" : "captures"}. It may be used by future mismatch detection.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => onReview(association.plateNumber, "confirm")}>
              {busy === confirmKey && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Confirm association
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>}
      {showReject && <AlertDialog>
        <AlertDialogTrigger asChild><Button variant="outline" disabled={Boolean(busy)}><XCircle className="mr-2 h-4 w-4" />Reject association</Button></AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject the {association.plateNumber} association?</AlertDialogTitle>
            <AlertDialogDescription>
              The ReID cluster and its captures are preserved. Only this proposed effective-plate association is rejected, with an audit record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => onReview(association.plateNumber, "reject")}>
              {busy === rejectKey && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Reject association
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>}
    </div>
  );
}

function FeatureReview({ capture, catalog, busy, onSave }) {
  const reviewedKeys = useMemo(() => capture.distinctiveFeatures
    .filter((feature) => feature.reviewed || feature.provider === "human-review")
    .map((feature) => feature.key), [capture.distinctiveFeatures]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(reviewedKeys);

  useEffect(() => setSelected(reviewedKeys), [reviewedKeys]);

  const toggle = (key, checked) => setSelected((current) => checked
    ? [...new Set([...current, key])]
    : current.filter((value) => value !== key));
  const save = async () => {
    const succeeded = await onSave(capture.readId, selected);
    if (succeeded) setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button variant="outline" size="sm" className="w-full"><ListChecks className="mr-2 h-4 w-4" />Review visible features</Button></PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))]">
        <div className="space-y-3">
          <div><div className="font-medium">Visible distinguishing features</div><div className="text-xs text-muted-foreground">Mark only features clearly visible in this capture. An unchecked item means it was not confirmed here—not that the vehicle never has it.</div></div>
          <div className="grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {catalog.map((feature) => (
              <label key={feature.key} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm">
                <Checkbox checked={selected.includes(feature.key)} onCheckedChange={(checked) => toggle(feature.key, checked === true)} />
                <span>{feature.label}</span>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button><Button size="sm" disabled={busy} onClick={save}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save reviewed features</Button></div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function VehicleProfile({ initialResult }) {
  const [result, setResult] = useState(initialResult);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const data = result?.success ? result.data : null;

  const reload = async () => {
    const next = await getVehicleProfile(data.id);
    setResult(next);
    if (!next.success) throw new Error(next.error);
  };

  const review = async (plateNumber, decision) => {
    setBusy(`${plateNumber}:${decision}`);
    setMessage("");
    try {
      const response = await reviewVehiclePlateAssociation({
        clusterId: data.id,
        plateNumber,
        decision,
      });
      if (!response.success) throw new Error(response.error);
      await reload();
      setMessage(decision === "confirm"
        ? `${plateNumber} is now a confirmed vehicle association.`
        : `${plateNumber} was rejected as an association for this vehicle.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };

  const reviewFeatures = async (readId, features) => {
    setBusy(`features:${readId}`);
    setMessage("");
    try {
      const response = await reviewVehicleDistinctiveFeatures({
        clusterId: data.id,
        readId,
        features,
      });
      if (!response.success) throw new Error(response.error);
      await reload();
      setMessage(`Saved ${features.length} reviewed distinguishing ${features.length === 1 ? "feature" : "features"} for read ${readId}.`);
      return true;
    } catch (error) {
      setMessage(error.message);
      return false;
    } finally {
      setBusy("");
    }
  };

  if (!data) return <div className="rounded-lg border border-destructive/30 p-4 text-destructive">{result?.error || "Unable to load vehicle profile."}</div>;
  const suggested = data.associations.filter((association) => association.status === "suggested");
  const confirmed = data.associations.filter((association) => association.status === "confirmed");
  const rejected = data.associations.filter((association) => association.status === "rejected");

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" className="-ml-3"><Link href="/visual_search/vehicles"><ArrowLeft className="mr-2 h-4 w-4" />All vehicles</Link></Button>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Card className="overflow-hidden">
          <div className="relative aspect-video bg-muted"><NextImage src={data.representativeImageUrl} alt={`Representative for Vehicle ${data.id}`} fill sizes="(min-width:1024px) 60vw, 100vw" className="object-cover" unoptimized /></div>
          <CardContent className="space-y-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-2xl font-semibold">Vehicle #{data.id}</h2><p className="text-sm text-muted-foreground">Representative read {data.representativeReadId} · {data.representativeCamera}</p></div><Badge variant={data.status === "confirmed" ? "default" : "secondary"}>{data.status}</Badge></div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border p-3"><div className="text-xl font-semibold">{data.captureCount}</div><div className="text-xs text-muted-foreground">captures</div></div>
              <div className="rounded-md border p-3"><div className="text-xl font-semibold">{data.confirmedCount}</div><div className="text-xs text-muted-foreground">confirmed members</div></div>
              <div className="rounded-md border p-3"><div className="text-xl font-semibold capitalize">{data.representativeColor || "Unknown"}</div><div className="text-xs text-muted-foreground">representative color {data.representativeColor ? `· ${percent(data.representativeColorConfidence)}` : ""}</div></div>
            </div>
            <div className="text-sm text-muted-foreground">Seen {when(data.firstSeen)} through {when(data.lastSeen)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" />Associated plates</CardTitle>
            <CardDescription>Only confirmed entries are trusted baselines. Suggestions use effective plates from human-confirmed cluster captures.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {message && <div className="rounded-md border p-3 text-sm">{message}</div>}
            {suggested.length === 0 && confirmed.length === 0 && <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Confirm at least one ReID grouping to create a plate-association suggestion.</div>}
            {suggested.map((association) => (
              <div key={association.id} className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
                <div className="flex items-start justify-between gap-3"><div><div className="font-mono text-lg font-semibold">{association.plateNumber}</div>{association.knownName && <div className="text-sm">{association.knownName}</div>}</div><Badge variant="outline">Suggested</Badge></div>
                <div className="text-sm text-muted-foreground">{association.evidenceCount} confirmed {association.evidenceCount === 1 ? "capture" : "captures"} · {percent(association.confidence)} mean ReID</div>
                <div className="flex flex-wrap gap-1">{association.tags.map((tag) => <Badge key={tag.name} variant="secondary">{tag.name}</Badge>)}</div>
                {data.canReview && <AssociationDecision association={association} busy={busy} onReview={review} />}
              </div>
            ))}
            {confirmed.map((association) => (
              <div key={association.id} className="space-y-3 rounded-lg border border-green-500/40 bg-green-500/5 p-4">
                <div className="flex items-start justify-between gap-3"><div><div className="font-mono text-lg font-semibold">{association.plateNumber}</div>{association.knownName && <div className="text-sm">{association.knownName}</div>}</div><Badge>Confirmed</Badge></div>
                <div className="mt-2 text-sm text-muted-foreground">{association.evidenceCount} confirmed {association.evidenceCount === 1 ? "capture" : "captures"} · last seen {when(association.lastSeen)}</div>
                {data.canReview && <AssociationDecision association={association} busy={busy} onReview={review} showConfirm={false} />}
              </div>
            ))}
            {rejected.length > 0 && <details><summary className="cursor-pointer text-sm text-muted-foreground">Rejected associations ({rejected.length})</summary><div className="mt-2 space-y-2">{rejected.map((association) => <div key={association.id} className="space-y-3 rounded-md border p-3 text-sm text-muted-foreground"><div className="font-mono">{association.plateNumber}</div>{data.canReview && <AssociationDecision association={association} busy={busy} onReview={review} showReject={false} />}</div>)}</div></details>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Tags className="h-5 w-5" />Distinguishing features</CardTitle>
          <CardDescription>Reviewed visible traits are per-capture evidence. Repeated observations from seed or confirmed members strengthen the profile without turning one unclear image into a permanent claim.</CardDescription>
        </CardHeader>
        <CardContent>
          {data.distinctiveFeatures.length > 0 ? (
            <div className="flex flex-wrap gap-2">{data.distinctiveFeatures.map((feature) => <Badge key={feature.key} variant="secondary">{feature.label} · {feature.captureCount} {feature.captureCount === 1 ? "capture" : "captures"}</Badge>)}</div>
          ) : <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No distinguishing features have been reviewed for this profile yet.</div>}
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div><h2 className="text-xl font-semibold">Recent profile captures</h2><p className="text-sm text-muted-foreground">Plate text is shown as evidence and was not used to create the ReID grouping.</p></div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.captures.map((capture) => (
            <Card key={capture.readId} className="overflow-hidden">
              <div className="relative aspect-video bg-muted"><NextImage src={capture.imageUrl} alt={`Vehicle capture ${capture.plateNumber}`} fill sizes="(min-width:1280px) 30vw, 50vw" className="object-cover" unoptimized /></div>
              <CardContent className="space-y-2 p-4">
                <div className="flex items-center justify-between gap-2"><span className="font-mono font-semibold">{capture.plateNumber}</span><Badge variant={capture.assignmentStatus === "confirmed" ? "default" : "secondary"}>{capture.assignmentStatus}</Badge></div>
                {capture.observedPlate !== capture.plateNumber && <div className="text-xs text-muted-foreground">Camera read {capture.observedPlate}</div>}
                <div className="text-sm text-muted-foreground">{capture.cameraName} · {when(capture.timestamp)}</div>
                <div className="flex flex-wrap gap-1">{capture.direction && <Badge variant="outline">{capture.direction}</Badge>}{capture.color && <Badge variant="outline" className="capitalize">{capture.color}</Badge>}{capture.similarity !== null && <Badge variant="outline">{percent(capture.similarity)} ReID</Badge>}</div>
                {capture.distinctiveFeatures.length > 0 && <div className="flex flex-wrap gap-1">{capture.distinctiveFeatures.map((feature) => <Badge key={`${feature.provider}:${feature.key}`} variant="secondary">{feature.label}</Badge>)}</div>}
                {data.canReview && <FeatureReview capture={capture} catalog={data.featureCatalog} busy={busy === `features:${capture.readId}`} onSave={reviewFeatures} />}
                <Button asChild variant="ghost" size="sm" className="px-0"><Link href={`/live_feed?search=${encodeURIComponent(capture.plateNumber)}&matchMode=off`}>Open in Live Feed <ExternalLink className="ml-2 h-3.5 w-3.5" /></Link></Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
