import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CarFront, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function hrefFor({ page, pageSize, search }) {
  const parameters = new URLSearchParams();
  if (page > 1) parameters.set("page", String(page));
  if (pageSize !== 24) parameters.set("pageSize", String(pageSize));
  if (search) parameters.set("search", search);
  const query = parameters.toString();
  return `/visual_search/profiles${query ? `?${query}` : ""}`;
}

export default function VehicleReidProfiles({ result, search = "" }) {
  if (!result?.success) {
    return <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">{result?.error || "Unable to load ReID profiles."}</div>;
  }
  const data = result.data;
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <CarFront className="h-6 w-6" />
          <h1 className="text-2xl font-semibold">Profiles</h1>
          <Badge>Authoritative ReID</Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Stable vehicle profiles built from exact current canonical Vehicle Views, trusted reviewed plates, and audited Same decisions. Similarity by itself never creates membership.
        </p>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card><CardContent className="p-4"><div className="text-2xl font-semibold">{data.overview.counts.profiles.toLocaleString()}</div><div className="text-xs text-muted-foreground">current profiles</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-2xl font-semibold">{data.overview.counts.provisionalProfiles.toLocaleString()}</div><div className="text-xs text-muted-foreground">provisional singletons</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-2xl font-semibold">{data.overview.counts.members.toLocaleString()}</div><div className="text-xs text-muted-foreground">current crop members</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-2xl font-semibold">{data.overview.counts.assignments.toLocaleString()}</div><div className="text-xs text-muted-foreground">active read assignments</div></CardContent></Card>
      </div>

      <form method="get" action="/visual_search/profiles" className="flex max-w-xl gap-2">
        <Input name="search" defaultValue={search} maxLength={80} placeholder="Profile number or reviewed plate" />
        <Button type="submit"><Search className="mr-2 h-4 w-4" />Search</Button>
        {search ? <Button asChild variant="outline"><Link href="/visual_search/profiles">Clear</Link></Button> : null}
      </form>

      {data.profiles.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.profiles.map((profile) => (
            <Card key={profile.id} className="overflow-hidden">
              <div className="relative aspect-video bg-muted">
                {profile.representativeImageUrl ? (
                  <Image src={profile.representativeImageUrl} alt={`Representative crop for vehicle ${profile.id}`} fill unoptimized sizes="(max-width: 768px) 100vw, 420px" className="object-contain" />
                ) : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Vehicle View unavailable</div>}
              </div>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-lg">Vehicle #{profile.id}</CardTitle>
                  <Badge variant={profile.status === "provisional" ? "secondary" : "default"}>{profile.status}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p>{profile.memberCount} crop member{profile.memberCount === 1 ? "" : "s"} · {profile.readCount} read{profile.readCount === 1 ? "" : "s"}</p>
                <p className="text-muted-foreground">{profile.anchorPlates.length ? profile.anchorPlates.join(" / ") : "No reviewed plate anchor"}</p>
                <Button asChild size="sm" variant="outline"><Link href={`/visual_search/profiles/${profile.id}`}>Open profile</Link></Button>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">No authoritative profiles match this search.</div>}

      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">Page {data.page} of {pageCount} · {data.total.toLocaleString()} profiles</span>
        <div className="flex gap-2">
          {data.page > 1 ? <Button asChild size="sm" variant="outline"><Link href={hrefFor({ page: data.page - 1, pageSize: data.pageSize, search })}><ArrowLeft className="mr-1 h-4 w-4" />Previous</Link></Button> : <Button size="sm" variant="outline" disabled><ArrowLeft className="mr-1 h-4 w-4" />Previous</Button>}
          {data.page < pageCount ? <Button asChild size="sm" variant="outline"><Link href={hrefFor({ page: data.page + 1, pageSize: data.pageSize, search })}>Next<ArrowRight className="ml-1 h-4 w-4" /></Link></Button> : <Button size="sm" variant="outline" disabled>Next<ArrowRight className="ml-1 h-4 w-4" /></Button>}
        </div>
      </div>
    </div>
  );
}
