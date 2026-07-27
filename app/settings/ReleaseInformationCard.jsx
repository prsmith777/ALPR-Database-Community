import {
  BookOpenText,
  ExternalLink,
  GitCommitHorizontal,
  PackageOpen,
  RadioTower,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  PROJECT_RELEASES_URL,
  PROJECT_REPOSITORY_URL,
} from "@/lib/project-info";

function ReleaseMetric({ icon: Icon, label, value, detail }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <p className="mt-2 break-all font-mono text-lg font-semibold">{value}</p>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

export default function ReleaseInformationCard({ release }) {
  const commitUrl = release.gitSha
    ? `${PROJECT_REPOSITORY_URL}/commit/${release.gitSha}`
    : null;

  return (
    <div className="max-w-5xl space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="flex items-center gap-2">
              <PackageOpen className="h-5 w-5 text-primary" aria-hidden="true" />
              Installed release
            </CardTitle>
            <Badge variant="secondary">Read only</Badge>
          </div>
          <CardDescription>
            Build identity supplied by this application and its commit-pinned deployment image.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <ReleaseMetric
              icon={PackageOpen}
              label="Application version"
              value={release.version}
              detail="From the installed application package"
            />
            <ReleaseMetric
              icon={BookOpenText}
              label="User manual"
              value={release.manualVersion}
              detail={`Updated ${release.manualUpdatedAt}`}
            />
            <ReleaseMetric
              icon={GitCommitHorizontal}
              label="Git SHA"
              value={release.gitSha || "Unavailable"}
              detail={`Source: ${release.source}`}
            />
            <ReleaseMetric
              icon={RadioTower}
              label="Release channel"
              value={release.channel}
              detail="Set by the deployment environment"
            />
          </div>

          <div className="flex flex-wrap gap-4 text-sm">
            {commitUrl ? (
              <a
                href={commitUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                View exact commit
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            ) : null}
            <a
              href={PROJECT_RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Project releases
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{release.notes.title}</CardTitle>
          <CardDescription>Published {release.notes.publishedAt}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            {release.notes.items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </CardContent>
      </Card>

      <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-4 text-sm">
        <p className="font-medium text-blue-700 dark:text-blue-300">
          Updates remain externally orchestrated
        </p>
        <p className="mt-1 text-muted-foreground">
          This page cannot fetch source code, run Git or Docker, apply migrations,
          restart services, install an update, or change the host. Releases continue
          through the documented backup, commit-pinned deployment, verification, and
          rollback process.
        </p>
      </div>
    </div>
  );
}
