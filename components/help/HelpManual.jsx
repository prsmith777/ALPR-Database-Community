"use client";

import { useMemo, useState } from "react";
import {
  BookOpenCheck,
  CheckCircle2,
  Download,
  FileText,
  Info,
  Search,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { HELP_ROLE_LABELS, manualSearchText } from "@/lib/help-manual.mjs";
import { cn } from "@/lib/utils";

const roleOrder = ["administrator", "operator", "viewer", "auditor"];

function RoleBadges({ roles }) {
  if (roles.length === roleOrder.length) {
    return <Badge variant="secondary">All signed-in roles</Badge>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {roles.map((role) => (
        <Badge key={role} variant="outline">
          {HELP_ROLE_LABELS[role]}
        </Badge>
      ))}
    </div>
  );
}

function NoteBlock({ block }) {
  const warning = block.tone === "warning";
  const Icon = warning ? TriangleAlert : Info;
  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        warning
          ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
          : "border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100"
      )}
    >
      <div className="flex gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div>
          <h3 className="font-semibold">{block.title}</h3>
          <p className="mt-1 text-sm leading-6">{block.text}</p>
        </div>
      </div>
    </div>
  );
}

function ExampleBlock({ block }) {
  return (
    <div className="rounded-lg border-l-4 border-l-blue-500 bg-muted/45 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{block.title}</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            <span className="font-medium text-foreground">Scenario: </span>
            {block.scenario}
          </p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6">
            {block.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="mt-3 rounded-md bg-background/80 p-3 text-sm leading-6">
            <span className="font-semibold">Expected result: </span>
            {block.result}
          </p>
        </div>
      </div>
    </div>
  );
}

function ManualBlock({ block }) {
  if (block.type === "note") return <NoteBlock block={block} />;
  if (block.type === "example") return <ExampleBlock block={block} />;
  if (block.type === "paragraph") {
    return <p className="text-sm leading-7 text-muted-foreground">{block.text}</p>;
  }
  if (block.type === "steps") {
    return (
      <div>
        <h3 className="font-semibold">{block.title}</h3>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </div>
    );
  }
  return (
    <div>
      <h3 className="font-semibold">{block.title}</h3>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6">
        {block.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export default function HelpManual({ manual }) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("all");

  const visibleSections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return manual.sections.filter((section) => {
      const matchesRole = role === "all" || section.roles.includes(role);
      const matchesQuery = !needle || manualSearchText(section).includes(needle);
      return matchesRole && matchesQuery;
    });
  }, [manual.sections, query, role]);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="rounded-xl border bg-gradient-to-br from-blue-50 via-background to-background p-5 dark:from-blue-950/35 sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2 text-sm font-medium text-blue-600 dark:text-blue-400">
              <BookOpenCheck className="h-5 w-5" aria-hidden="true" />
              Help Center
            </div>
            <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              {manual.title}
            </h1>
            <p className="mt-3 text-base leading-7 text-muted-foreground">
              {manual.description}
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary">Manual {manual.manualVersion}</Badge>
              <Badge variant="outline">Updated {manual.updatedAt}</Badge>
              <Badge variant="outline">{manual.coverageBaseline}</Badge>
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col xl:flex-row">
            <Button asChild>
              <a href="/api/help/manual" download={manual.filename}>
                <Download className="mr-2 h-4 w-4" aria-hidden="true" />
                Download PDF
              </a>
            </Button>
            <Button variant="outline" onClick={() => window.print()}>
              <FileText className="mr-2 h-4 w-4" aria-hidden="true" />
              Print this page
            </Button>
          </div>
        </div>
      </header>

      <section aria-label="Find help" className="mt-6 rounded-xl border bg-card p-4 sm:p-5">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div>
            <label htmlFor="help-search" className="text-sm font-medium">
              Search the guide
            </label>
            <div className="relative mt-2">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input
                id="help-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Try correction, MQTT, export, role, or password"
                className="pl-9"
              />
            </div>
          </div>
          <div>
            <div className="text-sm font-medium">Show guidance for</div>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Filter guide by role">
              <Button
                size="sm"
                variant={role === "all" ? "default" : "outline"}
                onClick={() => setRole("all")}
              >
                All roles
              </Button>
              {roleOrder.map((roleName) => (
                <Button
                  key={roleName}
                  size="sm"
                  variant={role === roleName ? "default" : "outline"}
                  onClick={() => setRole(roleName)}
                >
                  {HELP_ROLE_LABELS[roleName]}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground" aria-live="polite">
          Showing {visibleSections.length} of {manual.sections.length} sections.
        </p>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="h-fit rounded-xl border bg-card p-4 lg:sticky lg:top-4">
          <h2 className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="h-4 w-4 text-blue-500" aria-hidden="true" />
            In this guide
          </h2>
          <nav aria-label="Help topics" className="mt-3">
            {visibleSections.length ? (
              <ol className="space-y-1">
                {visibleSections.map((section, index) => (
                  <li key={section.id}>
                    <a
                      href={`#${section.id}`}
                      className="block rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="mr-2 text-xs text-blue-500">{index + 1}.</span>
                      {section.title}
                    </a>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">No matching topics.</p>
            )}
          </nav>
        </aside>

        <main className="min-w-0 space-y-6" id="manual-content">
          {visibleSections.length ? (
            visibleSections.map((section, index) => (
              <Card id={section.id} key={section.id} className="scroll-mt-6">
                <CardHeader>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-blue-500">
                        Topic {index + 1}
                      </div>
                      <CardTitle className="mt-1 text-2xl">{section.title}</CardTitle>
                      <CardDescription className="mt-2 text-sm leading-6">
                        {section.summary}
                      </CardDescription>
                    </div>
                    <RoleBadges roles={section.roles} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  {section.blocks.map((block, blockIndex) => (
                    <ManualBlock key={`${section.id}-${blockIndex}`} block={block} />
                  ))}
                </CardContent>
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="flex min-h-56 flex-col items-center justify-center p-8 text-center">
                <Search className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
                <h2 className="mt-3 font-semibold">No matching help topics</h2>
                <p className="mt-2 max-w-md text-sm text-muted-foreground">
                  Try a broader search or select All roles.
                </p>
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => {
                    setQuery("");
                    setRole("all");
                  }}
                >
                  Clear filters
                </Button>
              </CardContent>
            </Card>
          )}
        </main>
      </div>
    </div>
  );
}
