import Image from "next/image";
import Link from "next/link";
import { CarFront, Eye, ScanSearch } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function dateTime(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

export default function VehicleReidProfile({ result }) {
  if (!result?.success) {
    return <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">{result?.error || "Unable to load this ReID profile."}</div>;
  }
  const { profile, members, reads } = result.data;
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <CarFront className="h-6 w-6" />
          <h1 className="text-2xl font-semibold">Vehicle #{profile.id}</h1>
          <Badge variant={profile.status === "provisional" ? "secondary" : "default"}>{profile.status}</Badge>
          <Badge variant="outline">revision {profile.revision}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {profile.anchorPlates.length ? `Reviewed plate ${profile.anchorPlates.join(" / ")}` : "No reviewed plate anchor"} · {profile.memberCount} current crop member{profile.memberCount === 1 ? "" : "s"} · {profile.readCount} assigned read{profile.readCount === 1 ? "" : "s"}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Canonical Vehicle Views</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {members.map((member) => (
            <Card key={member.id} className="overflow-hidden">
              <div className="relative aspect-video bg-muted">
                {member.storagePath ? <Image src={`/images/${String(member.storagePath).replaceAll("\\", "/")}`} alt={`Canonical crop ${member.derivativeId}`} fill unoptimized sizes="(max-width: 768px) 100vw, 420px" className="object-contain" /> : null}
              </div>
              <CardHeader className="pb-2"><CardTitle className="text-base">Crop #{member.derivativeId}</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <p>Asset #{member.assetId} · embedding #{member.embeddingId}</p>
                <p>{member.effectivePlates.length ? member.effectivePlates.join(" / ") : "No frozen plate context"}</p>
                <Button asChild size="sm" variant="outline"><Link href={`/visual_search?source=${member.derivativeId}`}><ScanSearch className="mr-1 h-4 w-4" />Find similar</Link></Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Profile history</h2>
        {profile.readCount > reads.length ? <p className="text-sm text-muted-foreground">Showing the {reads.length} most recent of {profile.readCount} current assignments.</p> : null}
        <div className="space-y-2">
          {reads.map((read) => (
            <div key={read.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
              <div>
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{read.normalizedEffectivePlate || "Unknown plate"}</span>{read.knownName ? <Badge variant="secondary">{read.knownName}</Badge> : null}{read.tags.map((tag) => <Badge key={tag.name} style={{ backgroundColor: tag.color }} className="text-white">{tag.name}</Badge>)}</div>
                <p className="mt-1 text-xs text-muted-foreground">{read.cameraName || "Unknown camera"} · {dateTime(read.timestamp)} · {read.assignmentBasis.replaceAll("_", " ")}</p>
              </div>
              <Button asChild size="sm" variant="outline"><Link href={`/live_feed?readId=${read.id}`}><Eye className="mr-1 h-4 w-4" />Open read</Link></Button>
            </div>
          ))}
          {!reads.length ? <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">No current read assignments are available.</div> : null}
        </div>
      </section>
    </div>
  );
}
