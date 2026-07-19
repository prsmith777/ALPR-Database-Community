"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, FileJson, FileSpreadsheet, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PlateMatchModeSelect from "@/components/PlateMatchModeSelect";
import {
  readPlateMatchPreference,
  writePlateMatchPreference,
} from "@/lib/plate-match-preference.mjs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function hourLabel(hour) {
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:00 ${suffix}`;
}

export default function PlateExportForm({
  tags = [],
  cameras = [],
  matchingSettings,
}) {
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get("search") || "");
  const [matchMode, setMatchMode] = useState(
    () =>
      searchParams.get("matchMode") ||
      (searchParams.get("fuzzySearch") === "true"
        ? "balanced"
        : readPlateMatchPreference("downloads"))
  );
  const [tag, setTag] = useState(() => searchParams.get("tag") || "all");
  const [camera, setCamera] = useState(() => searchParams.get("camera") || "all");
  const [dateFrom, setDateFrom] = useState(() => searchParams.get("dateFrom") || "");
  const [dateTo, setDateTo] = useState(() => searchParams.get("dateTo") || "");
  const [hourFrom, setHourFrom] = useState(() => searchParams.get("hourFrom") || "all");
  const [hourTo, setHourTo] = useState(() => searchParams.get("hourTo") || "all");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (matchMode) params.set("matchMode", matchMode);
    if (tag !== "all") params.set("tag", tag);
    if (camera !== "all") params.set("camera", camera);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (hourFrom !== "all" && hourTo !== "all") {
      params.set("hourFrom", hourFrom);
      params.set("hourTo", hourTo);
    }
    if (searchParams.get("sortField")) {
      params.set("sortField", searchParams.get("sortField"));
      params.set("sortDirection", searchParams.get("sortDirection") || "desc");
    }
    return params;
  }, [camera, dateFrom, dateTo, hourFrom, hourTo, matchMode, search, searchParams, tag]);

  const startDownload = (format) => {
    const params = new URLSearchParams(query);
    params.set("format", format);
    window.location.assign(`/api/exports/plates?${params.toString()}`);
  };

  const handleMatchModeChange = (mode) => {
    const persistedMode = writePlateMatchPreference("downloads", mode);
    setMatchMode(persistedMode);
  };

  const clearFilters = () => {
    setSearch("");
    setTag("all");
    setCamera("all");
    setDateFrom("");
    setDateTo("");
    setHourFrom("all");
    setHourTo("all");
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" /> Export Plate Database
          </CardTitle>
          <CardDescription>
            Download up to 50,000 matching plate records. Filters use the same
            plate, tag, camera, date, and time rules as Plate Database.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="export-search">Plate, known name, or notes</Label>
              <div className="relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  id="export-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search matching records"
                  className="pl-9"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="export-match-mode">Plate matching</Label>
                <PlateMatchModeSelect
                  id="export-match-mode"
                  value={matchMode}
                  onValueChange={handleMatchModeChange}
                  settings={matchingSettings}
                />
                <p className="text-xs text-muted-foreground">
                  Uses the same matching profiles as Recognition Feed and Plate Database.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="export-tag">Tag</Label>
              <Select value={tag} onValueChange={setTag}>
                <SelectTrigger id="export-tag"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All tags</SelectItem>
                  <SelectItem value="untagged">Untagged</SelectItem>
                  {tags.map((item) => (
                    <SelectItem key={item.name} value={item.name}>{item.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="export-camera">Camera</Label>
              <Select value={camera} onValueChange={setCamera}>
                <SelectTrigger id="export-camera"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All cameras</SelectItem>
                  {cameras.map((item) => (
                    <SelectItem key={item} value={item}>{item}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="export-date-from">Seen on or after</Label>
              <Input id="export-date-from" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="export-date-to">Seen on or before</Label>
              <Input id="export-date-to" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="export-hour-from">First hour</Label>
              <Select value={hourFrom} onValueChange={setHourFrom}>
                <SelectTrigger id="export-hour-from"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any time</SelectItem>
                  {HOURS.map((hour) => <SelectItem key={hour} value={String(hour)}>{hourLabel(hour)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="export-hour-to">Last hour</Label>
              <Select value={hourTo} onValueChange={setHourTo}>
                <SelectTrigger id="export-hour-to"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any time</SelectItem>
                  {HOURS.map((hour) => <SelectItem key={hour} value={String(hour)}>{hourLabel(hour)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t pt-5 sm:flex-row sm:items-center">
            <Button onClick={() => startDownload("csv")}>
              <FileSpreadsheet className="mr-2 h-4 w-4" /> Download CSV
            </Button>
            <Button variant="secondary" onClick={() => startDownload("json")}>
              <FileJson className="mr-2 h-4 w-4" /> Download JSON
            </Button>
            <Button variant="ghost" onClick={clearFilters} className="sm:ml-auto">
              Clear filters
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Exports contain database text and timestamps only. Image ZIP export
            remains deferred until user roles and export auditing are available.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
