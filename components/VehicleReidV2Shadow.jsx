import NextImage from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  Camera,
  Database,
  Eye,
  Info,
  Search,
  ShieldCheck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function dateTime(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function percent(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "Unavailable";
}

function sourceTitle(source) {
  return source?.plateNumbers?.length
    ? source.plateNumbers.join(" / ")
    : `Canonical crop #${source?.derivativeId || "—"}`;
}

function queryHref(data, overrides = {}) {
  const values = {
    search: data?.filters?.search || "",
    page: data?.pagination?.page || 1,
    pageSize: data?.pagination?.pageSize || 12,
    source: data?.selected?.derivativeId || "",
    ...overrides,
  };
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== "" && value !== null && value !== undefined) {
      parameters.set(key, String(value));
    }
  }
  return `/visual_search/reid-v2?${parameters.toString()}`;
}

function AttributeBadge({ label, attribute }) {
  const value = attribute?.status === "ready" ? attribute.value : attribute?.status || "missing";
  return <Badge variant="outline">{label}: {value}</Badge>;
}

function EvidenceBadge({ label, state }) {
  const positive = state === true || state === "agrees";
  const unavailable = state === "unavailable";
  const text = unavailable ? "unavailable" : positive ? "agrees" : "differs";
  return (
    <Badge variant={positive ? "default" : "secondary"}>
      {label}: {text}
    </Badge>
  );
}

function VehicleImage({ source, priority = false }) {
  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-lg border bg-muted">
      <NextImage
        src={source.imageUrl}
        alt={`Canonical vehicle crop for ${sourceTitle(source)}`}
        fill
        priority={priority}
        sizes="(max-width: 768px) 100vw, 420px"
        className="object-contain"
      />
    </div>
  );
}

function SourceMetadata({ source }) {
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap gap-2">
        <AttributeBadge label="Color" attribute={source.attributes.color} />
        <AttributeBadge label="Body" attribute={source.attributes.bodyType} />
      </div>
      <p className="text-muted-foreground">
        <Camera className="mr-1 inline h-4 w-4" />
        {source.cameraNames?.join(", ") || source.cameraName || "Unknown camera"} · {dateTime(source.timestamp)}
      </p>
      <p className="text-xs text-muted-foreground">
        Crop #{source.derivativeId.toLocaleString()} · asset #{source.assetId.toLocaleString()} · read #{source.readId.toLocaleString()}
      </p>
      <div className="flex flex-wrap gap-2 text-xs">
        {source.currentProfileIds?.length
          ? source.currentProfileIds.map((profileId) => (
            <Link key={profileId} className="text-blue-500 hover:underline" href={`/visual_search/vehicles/${profileId}`}>
              Current v1 grouping #{profileId}
            </Link>
          ))
          : <span className="text-muted-foreground">No current v1 grouping</span>}
      </div>
    </div>
  );
}

function SourcePicker({ data }) {
  if (!data.sources.length) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
        No current canonical crops match this search.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data.sources.map((source) => {
          const selected = source.derivativeId === data.selected?.derivativeId;
          return (
            <Link
              key={source.derivativeId}
              href={queryHref(data, { source: source.derivativeId })}
              className={`rounded-lg border p-3 transition-colors hover:border-primary ${selected ? "border-primary bg-primary/5" : ""}`}
            >
              <div className="relative mb-3 aspect-[16/9] overflow-hidden rounded-md bg-muted">
                <NextImage
                  src={source.imageUrl}
                  alt={`Choose ${sourceTitle(source)} as the shadow source`}
                  fill
                  sizes="(max-width: 768px) 50vw, 280px"
                  className="object-contain"
                />
              </div>
              <div className="font-medium">{sourceTitle(source)}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {source.cameraName || "Unknown camera"} · crop #{source.derivativeId}
              </div>
            </Link>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">
          Page {data.pagination.page} of {data.pagination.pageCount} · {data.pagination.total.toLocaleString()} matching crops
        </span>
        <div className="flex gap-2">
          {data.pagination.page > 1
            ? <Button asChild variant="outline" size="sm"><Link href={queryHref(data, { page: data.pagination.page - 1 })}><ArrowLeft className="mr-1 h-4 w-4" />Previous</Link></Button>
            : <Button variant="outline" size="sm" disabled><ArrowLeft className="mr-1 h-4 w-4" />Previous</Button>}
          {data.pagination.page < data.pagination.pageCount
            ? <Button asChild variant="outline" size="sm"><Link href={queryHref(data, { page: data.pagination.page + 1 })}>Next<ArrowRight className="ml-1 h-4 w-4" /></Link></Button>
            : <Button variant="outline" size="sm" disabled>Next<ArrowRight className="ml-1 h-4 w-4" /></Button>}
        </div>
      </div>
    </div>
  );
}

function MatchCard({ selected, match }) {
  return (
    <Card>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-lg">#{match.rank} · {sourceTitle(match)}</CardTitle>
            <CardDescription>Embedding-only cosine ranking</CardDescription>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums">{percent(match.similarity)}</div>
            <div className="text-xs text-muted-foreground">
              {match.marginToNext == null ? "Final displayed candidate" : `${percent(match.marginToNext, 2)} to next`}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <VehicleImage source={match} />
        <SourceMetadata source={match} />
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review evidence — not scoring inputs</p>
          <div className="flex flex-wrap gap-2">
            <EvidenceBadge label="Plate" state={match.reviewEvidence.plateAgreement} />
            <EvidenceBadge label="Current v1 grouping" state={match.reviewEvidence.currentProfileAgreement} />
            <EvidenceBadge label="Color" state={match.reviewEvidence.colorAgreement} />
            <EvidenceBadge label="Body" state={match.reviewEvidence.bodyTypeAgreement} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/live_feed?readId=${match.readId}`}><Eye className="mr-1 h-4 w-4" />Open read</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={queryHref({ filters: { search: "" }, pagination: { page: 1, pageSize: 12 }, selected }, { source: match.derivativeId })}>
              Use as source<ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function VehicleReidV2Shadow({ result }) {
  if (!result?.success) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-5 text-sm text-destructive">
        {result?.error || "Unable to load ReID v2 shadow comparisons."}
      </div>
    );
  }

  const data = result.data;
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <BrainCircuit className="h-6 w-6" />
              <h1 className="text-2xl font-semibold">ReID v2 Shadow</h1>
              <Badge>Read-only</Badge>
            </div>
            <p className="max-w-4xl text-sm text-muted-foreground">
              Compare each current canonical Overview crop against the local crop-embedding catalog. This page does not create or change a vehicle profile, assignment, notification, or external-provider result.
            </p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Card><CardContent className="flex items-center gap-3 p-4"><Database className="h-5 w-5" /><div><div className="text-xl font-semibold">{data.stats.totalSources.toLocaleString()}</div><div className="text-xs text-muted-foreground">current identity crops</div></div></CardContent></Card>
          <Card><CardContent className="flex items-center gap-3 p-4"><Search className="h-5 w-5" /><div><div className="text-xl font-semibold">{data.stats.scannedSources.toLocaleString()}</div><div className="text-xs text-muted-foreground">crops scanned locally</div></div></CardContent></Card>
          <Card><CardContent className="flex items-center gap-3 p-4"><ShieldCheck className="h-5 w-5" /><div><div className="text-xl font-semibold">{data.stats.fullyAttributed.toLocaleString()}</div><div className="text-xs text-muted-foreground">with both review attributes</div></div></CardContent></Card>
        </div>
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 text-sm">
          <p className="font-medium"><Info className="mr-2 inline h-4 w-4" />How to read this page</p>
          <p className="mt-1 text-muted-foreground">
            Candidate order uses only cosine similarity from {data.modelName}. Plate, current v1 grouping, color, and body-type agreement are displayed afterward for human review and never alter the score or order. Shared images are scanned once; display-only Entry fallbacks are excluded.
          </p>
        </div>
        {data.stats.truncated ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-muted-foreground">
            This installation has more than 10,000 current crops. Search and ranking are intentionally bounded to the newest {data.stats.scannedSources.toLocaleString()} sources.
          </div>
        ) : null}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold">Choose a source crop</h2>
          <p className="text-sm text-muted-foreground">Search by plate, camera, read ID, asset ID, or crop ID.</p>
        </div>
        <form method="get" action="/visual_search/reid-v2" className="flex max-w-2xl gap-2">
          <Input name="search" defaultValue={data.filters.search} maxLength={80} placeholder="Search current canonical crops" />
          <Button type="submit"><Search className="mr-2 h-4 w-4" />Search</Button>
          {data.filters.search ? <Button asChild type="button" variant="outline"><Link href="/visual_search/reid-v2">Clear</Link></Button> : null}
        </form>
        <SourcePicker data={data} />
      </section>

      {data.selected ? (
        <section className="space-y-5">
          <div>
            <h2 className="text-xl font-semibold">Shadow neighborhood for {sourceTitle(data.selected)}</h2>
            <p className="text-sm text-muted-foreground">
              The top-two margin is {data.winnerMargin == null ? "unavailable" : percent(data.winnerMargin, 2)}. This is comparison evidence, not an automatic match decision.
            </p>
          </div>
          <div className="grid gap-5 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,2fr)]">
            <Card className="h-fit lg:sticky lg:top-4">
              <CardHeader><CardTitle>{sourceTitle(data.selected)}</CardTitle><CardDescription>Selected canonical source</CardDescription></CardHeader>
              <CardContent className="space-y-4">
                <VehicleImage source={data.selected} priority />
                <SourceMetadata source={data.selected} />
                <Button asChild variant="outline" size="sm"><Link href={`/live_feed?readId=${data.selected.readId}`}><Eye className="mr-1 h-4 w-4" />Open source read</Link></Button>
              </CardContent>
            </Card>
            <div className="grid gap-4 xl:grid-cols-2">
              {data.matches.length
                ? data.matches.map((match) => <MatchCard key={match.derivativeId} selected={data.selected} match={match} />)
                : <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No other valid current crop embeddings are available for comparison.</div>}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
