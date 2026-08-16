import NextImage from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  BarChart3,
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
import VehicleReidV2PairReviewControls from "@/components/VehicleReidV2PairReviewControls";

function dateTime(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function percent(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "Unavailable";
}

function scoreRange(summary) {
  if (summary?.minimum == null || summary?.maximum == null) return "No labels yet";
  return `${summary.minimum.toFixed(1)}%–${summary.maximum.toFixed(1)}%`;
}

function evaluationCount(group) {
  return `${group.sameVehicle} same · ${group.differentVehicle} different · ${group.unsure} unsure`;
}

function EvaluationTable({ title, description, rows = [] }) {
  return (
    <details className="rounded-lg border bg-muted/20 p-3">
      <summary className="cursor-pointer text-sm font-medium">{title}</summary>
      <p className="mt-2 text-xs text-muted-foreground">{description}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="px-2 py-2 font-medium">Stratum</th>
              <th className="px-2 py-2 text-right font-medium">Total</th>
              <th className="px-2 py-2 text-right font-medium">Same / range</th>
              <th className="px-2 py-2 text-right font-medium">Different / range</th>
              <th className="px-2 py-2 text-right font-medium">Unsure</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b last:border-0">
                <td className="px-2 py-2 font-medium">{row.key}</td>
                <td className="px-2 py-2 text-right tabular-nums">{row.total}</td>
                <td className="px-2 py-2 text-right tabular-nums">
                  <div>{row.sameVehicle}</div>
                  <div className="text-muted-foreground">{scoreRange(row.sameScores)}</div>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  <div>{row.differentVehicle}</div>
                  <div className="text-muted-foreground">{scoreRange(row.differentScores)}</div>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{row.unsure}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function StratifiedEvaluation({ evaluation }) {
  if (!evaluation) return null;
  const separation = evaluation.separation || {};
  const overlap = separation.overlapMinimum != null && separation.overlapMaximum != null
    ? `${separation.overlapMinimum.toFixed(1)}%–${separation.overlapMaximum.toFixed(1)}%`
    : "No observed overlap";
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <BarChart3 className="h-5 w-5" />Stratified offline evaluation
        </h3>
        <p className="text-sm text-muted-foreground">
          Read-only analysis of the reviewed pairs. It applies no threshold and writes no profile, cluster, or assignment.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card><CardContent className="p-4"><div className="text-xl font-semibold">{evaluation.decisive.toLocaleString()}</div><div className="text-xs text-muted-foreground">decisive labels evaluated</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xl font-semibold">{overlap}</div><div className="text-xs text-muted-foreground">observed same/different overlap</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xl font-semibold">{separation.perfectGlobalSeparation === false ? "No" : separation.perfectGlobalSeparation === true ? "Yes" : "Not enough data"}</div><div className="text-xs text-muted-foreground">perfect global cutoff separation</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xl font-semibold">0</div><div className="text-xs text-muted-foreground">thresholds or assignments applied</div></CardContent></Card>
      </div>
      {separation.perfectGlobalSeparation === false ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          No single cosine cutoff perfectly separates these reviewed examples. Inside the observed {overlap} overlap are {separation.sameInOverlap} Same, {separation.differentInOverlap} Different, and {separation.unsureInOverlap} Unsure labels.
        </div>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        <EvaluationTable
          title="Score bands"
          description="Cosine score is grouped descriptively; labels never alter score or order."
          rows={evaluation.byScoreBand}
        />
        <EvaluationTable
          title="Camera pairs"
          description="Frozen review-time camera evidence, independent of current assignments."
          rows={evaluation.byCameraPair}
        />
        <EvaluationTable
          title="Overview contexts"
          description="Entry and Street evidence combinations retained with each pair review."
          rows={evaluation.byContext}
        />
        <EvaluationTable
          title={`Local capture periods · ${evaluation.timeZone}`}
          description={evaluation.localPeriodDefinition}
          rows={evaluation.byLocalPeriod}
        />
        <EvaluationTable
          title="Effective-plate evidence"
          description="Plate agreement is review context only and is never used by ReID v2 scoring."
          rows={evaluation.byPlateEvidence}
        />
      </div>
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <p className="text-sm font-medium">Targeted coverage gaps</p>
        <p className="text-xs text-muted-foreground">
          These identify the next small review sample; they are not a request to review every remaining pair. The camera/time floor is {evaluation.targetedCoverageFloor} examples per decisive label, and overlapping score bands use {evaluation.targetedOverlapBandFloor}.
        </p>
        {evaluation.targetedGaps.length ? (
          <ul className="space-y-1 text-xs">
            {evaluation.targetedGaps.map((gap) => (
              <li key={`${gap.dimension}:${gap.key}`}>
                <span className="font-medium">{gap.dimension} · {gap.key}</span>
                {` — ${evaluationCount(gap)}; target ${gap.neededSameVehicle} more Same and ${gap.neededDifferentVehicle} more Different.`}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No coverage gap was identified at the descriptive sample floors.</p>
        )}
      </div>
    </div>
  );
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
        unoptimized
        priority={priority}
        sizes="(max-width: 768px) 100vw, 420px"
        className="object-contain"
      />
    </div>
  );
}

function LprEvidenceCard({ evidence }) {
  const companion = evidence.evidenceType === "shadow_event_companion";
  const observedDiffers = evidence.observedPlate
    && evidence.plateNumber
    && evidence.observedPlate.toLowerCase() !== evidence.plateNumber.toLowerCase();
  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <div className="relative aspect-video bg-muted">
        {evidence.imageUrl ? (
          <NextImage
            src={evidence.imageUrl}
            alt={`LPR plate capture for ${evidence.plateNumber || `read ${evidence.readId}`}`}
            fill
            unoptimized
            sizes="(max-width: 768px) 50vw, 220px"
            className="object-contain"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
            Stored plate-capture image unavailable
          </div>
        )}
      </div>
      <div className="space-y-1.5 p-2 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <span className="font-semibold">{evidence.plateNumber || "Unknown plate"}</span>
          <Badge variant={companion ? "secondary" : "outline"}>
            {companion ? "Event companion" : "Direct link"}
          </Badge>
        </div>
        {observedDiffers ? (
          <p className="text-muted-foreground">Observed {evidence.observedPlate}</p>
        ) : null}
        <p className="text-muted-foreground">
          {evidence.cameraName || "Unknown camera"} · {dateTime(evidence.timestamp)}
        </p>
        <p className="text-muted-foreground">
          {evidence.directionLabel || "Direction unavailable"}
          {companion && evidence.eventId ? ` · shadow event #${evidence.eventId}` : ""}
        </p>
        <Link className="inline-flex items-center text-blue-500 hover:underline" href={`/live_feed?readId=${evidence.readId}`}>
          Open LPR read #{evidence.readId}
        </Link>
      </div>
    </div>
  );
}

function LprEvidencePanel({ source }) {
  const direct = source?.lprEvidence?.direct || [];
  const companions = source?.lprEvidence?.companions || [];
  const conflicts = source?.lprEvidence?.conflicts || {};
  const hasConflict = conflicts.plate || conflicts.direction;
  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Associated LPR evidence — review only
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Plate captures and conservative shadow-event companions never affect similarity or candidate order.
        </p>
      </div>
      {hasConflict ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mr-1 inline h-4 w-4" />
          Linked evidence conflicts on {conflicts.plate && conflicts.direction
            ? "plate and direction"
            : conflicts.plate ? "plate" : "direction"}. Use Unsure unless the images resolve it.
        </div>
      ) : null}
      {direct.length ? (
        <div className="space-y-2">
          <p className="text-xs font-medium">Directly linked LPR read{direct.length === 1 ? "" : "s"}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {direct.map((evidence) => <LprEvidenceCard key={`direct:${evidence.readId}`} evidence={evidence} />)}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No current directly linked LPR evidence is available.</p>
      )}
      {companions.length ? (
        <div className="space-y-2">
          <p className="text-xs font-medium">Correlated companion LPR read{companions.length === 1 ? "" : "s"}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {companions.map((evidence) => <LprEvidenceCard key={`companion:${evidence.readId}`} evidence={evidence} />)}
          </div>
        </div>
      ) : null}
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
                  unoptimized
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

function MatchCard({ selected, match, canReview }) {
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
        <LprEvidencePanel source={match} />
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
        <VehicleReidV2PairReviewControls
          sourceDerivativeId={selected.derivativeId}
          candidateDerivativeId={match.derivativeId}
          initialReview={match.pairReview}
          canReview={canReview}
        />
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
              <Badge>Assignment-safe review</Badge>
            </div>
            <p className="max-w-4xl text-sm text-muted-foreground">
              Compare each current canonical Overview crop against the local crop-embedding catalog. Human pair labels are retained for calibration, but this page does not create or change a vehicle profile, assignment, threshold, notification, or external-provider result.
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
            Candidate order uses only cosine similarity from {data.modelName}. Plate, current v1 grouping, color, body type, and saved human labels are displayed afterward for review and never alter the score or order. Shared images are scanned once; display-only Entry fallbacks are excluded.
          </p>
        </div>
        {data.stats.truncated ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-muted-foreground">
            This installation has more than 10,000 current crops. Search and ranking are intentionally bounded to the newest {data.stats.scannedSources.toLocaleString()} sources.
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-xl font-semibold">Human-labeled calibration evidence</h2>
          <p className="text-sm text-muted-foreground">
            Labels are bound to the exact immutable crop pair and embedding contract. Score ranges are descriptive only; no threshold is recommended or applied.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Card><CardContent className="p-4"><div className="text-xl font-semibold">{data.calibration.total.toLocaleString()}</div><div className="text-xs text-muted-foreground">reviewed pairs</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xl font-semibold">{data.calibration.sameVehicle.toLocaleString()}</div><div className="text-xs text-muted-foreground">same vehicle · {scoreRange(data.calibration.sameScores)}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xl font-semibold">{data.calibration.differentVehicle.toLocaleString()}</div><div className="text-xs text-muted-foreground">different vehicle · {scoreRange(data.calibration.differentScores)}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xl font-semibold">{data.calibration.unsure.toLocaleString()}</div><div className="text-xs text-muted-foreground">unsure</div></CardContent></Card>
        </div>
        {data.calibration.byCameraPair.length ? (
          <div className="flex flex-wrap gap-2 text-xs">
            {data.calibration.byCameraPair.map((pair) => (
              <Badge key={pair.key} variant="outline">
                {pair.key}: {pair.total} review{pair.total === 1 ? "" : "s"}
              </Badge>
            ))}
          </div>
        ) : null}
        <StratifiedEvaluation evaluation={data.evaluation} />
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
                <LprEvidencePanel source={data.selected} />
                <SourceMetadata source={data.selected} />
                <Button asChild variant="outline" size="sm"><Link href={`/live_feed?readId=${data.selected.readId}`}><Eye className="mr-1 h-4 w-4" />Open source read</Link></Button>
              </CardContent>
            </Card>
            <div className="grid gap-4 xl:grid-cols-2">
              {data.matches.length
                ? data.matches.map((match) => <MatchCard key={match.derivativeId} selected={data.selected} match={match} canReview={data.canReview} />)
                : <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No other valid current crop embeddings are available for comparison.</div>}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
