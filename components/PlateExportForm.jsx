"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { format } from "date-fns";
import {
  ChevronDown,
  Download,
  FileJson,
  FileSpreadsheet,
  Search,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PlateMatchModeSelect from "@/components/PlateMatchModeSelect";
import MultiSelectFilter from "@/components/MultiSelectFilter";
import LiveFeedDateRangeFilter from "@/components/LiveFeedDateRangeFilter";
import FilterHourRange from "@/components/FilterHourRange";
import {
  readPlateMatchPreference,
  writePlateMatchPreference,
} from "@/lib/plate-match-preference.mjs";

function localDate(value) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

export default function PlateExportForm({
  tags = [],
  cameras = [],
  matchingSettings,
  timeFormat = 12,
}) {
  const searchParams = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState(() => searchParams.get("search") || "");
  const [matchMode, setMatchMode] = useState(
    () =>
      searchParams.get("matchMode") ||
      (searchParams.get("fuzzySearch") === "true"
        ? "balanced"
        : readPlateMatchPreference("downloads"))
  );
  const [selectedTags, setSelectedTags] = useState(() =>
    searchParams.getAll("tag").filter((tag) => tag && tag !== "all")
  );
  const [selectedCameras, setSelectedCameras] = useState(() =>
    searchParams.getAll("camera").filter(Boolean)
  );
  const [dateFrom, setDateFrom] = useState(() => searchParams.get("dateFrom") || "");
  const [dateTo, setDateTo] = useState(() => searchParams.get("dateTo") || "");
  const [hourFrom, setHourFrom] = useState(() => searchParams.get("hourFrom") || "all");
  const [hourTo, setHourTo] = useState(() => searchParams.get("hourTo") || "all");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (matchMode) params.set("matchMode", matchMode);
    selectedTags.forEach((tag) => params.append("tag", tag));
    selectedCameras.forEach((camera) => params.append("camera", camera));
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
  }, [
    dateFrom,
    dateTo,
    hourFrom,
    hourTo,
    matchMode,
    search,
    searchParams,
    selectedCameras,
    selectedTags,
  ]);

  const dateRange = { from: localDate(dateFrom), to: localDate(dateTo) };
  const hourRange =
    hourFrom !== "all" && hourTo !== "all"
      ? { from: Number(hourFrom), to: Number(hourTo) }
      : null;
  const hasActiveFilters = Boolean(
    search.trim() ||
      selectedTags.length ||
      selectedCameras.length ||
      dateFrom ||
      dateTo ||
      hourRange
  );

  const startDownload = (downloadFormat) => {
    const params = new URLSearchParams(query);
    params.set("format", downloadFormat);
    window.location.assign(`/api/exports/plates?${params.toString()}`);
  };

  const handleMatchModeChange = (mode) => {
    setMatchMode(writePlateMatchPreference("downloads", mode));
  };

  const handleDateRangeChange = (range) => {
    setDateFrom(range ? format(range.from, "yyyy-MM-dd") : "");
    setDateTo(range ? format(range.to, "yyyy-MM-dd") : "");
  };

  const handleHourRangeChange = (range) => {
    setHourFrom(range ? String(range.from) : "all");
    setHourTo(range ? String(range.to) : "all");
  };

  const clearFilters = () => {
    setSearch("");
    setSelectedTags([]);
    setSelectedCameras([]);
    setDateFrom("");
    setDateTo("");
    setHourFrom("all");
    setHourTo("all");
  };

  return (
    <div className="w-full space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" /> Export Plate Database
          </CardTitle>
          <CardDescription>
            Download matching database text and timestamps as CSV or JSON.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-3 sm:gap-4">
              <button
                type="button"
                className="flex min-w-64 flex-1 items-center justify-between gap-3 rounded-md text-left"
                aria-expanded={isOpen}
                aria-controls="plate-export-search-options"
                onClick={() => setIsOpen((current) => !current)}
              >
                <span>
                  <span className="block font-semibold">Search options</span>
                  <span className="block text-sm text-muted-foreground">
                    Plate search, matching, and filters
                  </span>
                </span>
                <ChevronDown
                  className={`h-5 w-5 shrink-0 text-muted-foreground transition-transform ${
                    isOpen ? "rotate-180" : ""
                  }`}
                  aria-hidden="true"
                />
              </button>
              <div className="flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 dark:bg-[#161618]">
                <span className="text-sm text-muted-foreground">Up to</span>
                <span className="font-medium">50,000</span>
                <span className="text-sm text-muted-foreground">rows</span>
              </div>
            </div>

            {isOpen && (
              <div id="plate-export-search-options" className="mt-4 border-t pt-4">
                <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-5">
                  <div className="relative sm:col-span-2">
                    <Label htmlFor="export-search" className="sr-only">
                      Plate, known name, or notes
                    </Label>
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="export-search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search plates, names, or notes..."
                      className="h-9 pl-9 dark:bg-[#161618]"
                    />
                  </div>
                  <div>
                    <Label htmlFor="export-match-mode" className="sr-only">Plate matching</Label>
                    <PlateMatchModeSelect
                      id="export-match-mode"
                      value={matchMode}
                      onValueChange={handleMatchModeChange}
                      settings={matchingSettings}
                      prefixLabel="Plate matching"
                      ariaLabel="Plate matching"
                      className="h-9 w-full"
                    />
                  </div>
                  <div>
                    <Label htmlFor="export-tag" className="sr-only">Tags</Label>
                    <MultiSelectFilter
                      id="export-tag"
                      ariaLabel="Filter export by tags"
                      allLabel="All tags"
                      value={selectedTags}
                      options={[
                        { value: "untagged", label: "Untagged", color: "#6B7280" },
                        ...tags.map((item) => ({
                          value: item.name,
                          label: item.name,
                          color: item.color,
                        })),
                      ]}
                      exclusiveValues={["untagged"]}
                      onChange={setSelectedTags}
                      className="h-9 w-full dark:bg-[#161618]"
                    />
                  </div>
                  <div>
                    <Label htmlFor="export-camera" className="sr-only">Cameras</Label>
                    <MultiSelectFilter
                      id="export-camera"
                      ariaLabel="Filter export by cameras"
                      allLabel="All cameras"
                      value={selectedCameras}
                      options={cameras.map((item) => ({ value: item, label: item }))}
                      onChange={setSelectedCameras}
                      className="h-9 w-full dark:bg-[#161618]"
                    />
                  </div>
                  <LiveFeedDateRangeFilter
                    value={dateRange}
                    onChange={handleDateRangeChange}
                    triggerClassName="w-full justify-start"
                    mobileVisible
                  />
                  <FilterHourRange
                    value={hourRange}
                    onChange={handleHourRangeChange}
                    timeFormat={timeFormat}
                  />
                </div>
              </div>
            )}
          </div>

          {hasActiveFilters && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="whitespace-nowrap text-xs text-muted-foreground">Active filters:</span>
              {search.trim() && <Badge variant="outline">Search: {search.trim()}</Badge>}
              {selectedTags.length > 0 && <Badge variant="outline">Tags: {selectedTags.join(", ")}</Badge>}
              {selectedCameras.length > 0 && <Badge variant="outline">Cameras: {selectedCameras.join(", ")}</Badge>}
              {(dateFrom || dateTo) && <Badge variant="outline">Date: {dateFrom || "Any"} - {dateTo || "Any"}</Badge>}
              {hourRange && <Badge variant="outline">Hours: {hourRange.from} - {hourRange.to}</Badge>}
              <Button variant="outline" size="sm" onClick={clearFilters} className="h-6 gap-1 px-2 text-xs">
                <X className="h-3.5 w-3.5" /> Clear filters
              </Button>
            </div>
          )}

          <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center">
            <Button onClick={() => startDownload("csv")}>
              <FileSpreadsheet className="mr-2 h-4 w-4" /> Download CSV
            </Button>
            <Button variant="secondary" onClick={() => startDownload("json")}>
              <FileJson className="mr-2 h-4 w-4" /> Download JSON
            </Button>
            <p className="text-xs text-muted-foreground sm:ml-auto">
              Exports contain database text and timestamps only.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
