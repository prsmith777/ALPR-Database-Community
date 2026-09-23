"use client";

import { useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { ChevronDown, Download, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PlateMatchModeSelect from "@/components/PlateMatchModeSelect";
import MultiSelectFilter from "@/components/MultiSelectFilter";
import LiveFeedDateRangeFilter from "@/components/LiveFeedDateRangeFilter";
import FilterHourRange from "@/components/FilterHourRange";
import { useAccess } from "@/components/auth/AccessProvider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function localDate(value) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function exportHref(filters, sortConfig) {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.matchMode) params.set("matchMode", filters.matchMode);
  (filters.tags || []).forEach((tag) => params.append("tag", tag));
  (filters.cameraNames || []).forEach((camera) => params.append("camera", camera));
  if (filters.dateRange.from) params.set("dateFrom", filters.dateRange.from);
  if (filters.dateRange.to) params.set("dateTo", filters.dateRange.to);
  if (filters.hourRange) {
    params.set("hourFrom", String(filters.hourRange.from));
    params.set("hourTo", String(filters.hourRange.to));
  }
  params.set("sortField", sortConfig.key);
  params.set("sortDirection", sortConfig.direction);
  return `/download?${params.toString()}`;
}

export default function PlateDatabaseFilters({
  filters,
  onChange,
  onClear,
  availableTags,
  availableCameras,
  pageSize,
  onPageSizeChange,
  sortConfig,
  matchingSettings,
  timeFormat = 12,
}) {
  const { can } = useAccess();
  const [isOpen, setIsOpen] = useState(false);
  const selectedDateRange = {
    from: localDate(filters.dateRange.from),
    to: localDate(filters.dateRange.to),
  };
  const tagOptions = [
    { value: "untagged", label: "Untagged", color: "#6B7280" },
    ...availableTags.map((tag) => ({
      value: tag.name,
      label: tag.name,
      color: tag.color,
    })),
  ];
  const cameraOptions = availableCameras.map((camera) => ({
    value: camera,
    label: camera,
  }));
  const hasActiveFilters = Boolean(
    filters.search.trim() ||
      filters.tags.length ||
      filters.cameraNames.length ||
      filters.dateRange.from ||
      filters.dateRange.to ||
      filters.hourRange
  );

  const handleDateRangeChange = (range) => {
    onChange({
      dateRange: range
        ? {
            from: format(range.from, "yyyy-MM-dd"),
            to: format(range.to, "yyyy-MM-dd"),
          }
        : { from: "", to: "" },
    });
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <button
            type="button"
            className="flex min-w-64 flex-1 items-center justify-between gap-3 rounded-md text-left"
            aria-expanded={isOpen}
            aria-controls="plate-database-search-options"
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
            <Label htmlFor="plate-database-page-size" className="text-sm text-muted-foreground">
              Show
            </Label>
            <Select value={String(pageSize)} onValueChange={onPageSizeChange}>
              <SelectTrigger
                id="plate-database-page-size"
                aria-label="Database results per page"
                className="h-9 w-24"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 25, 50, 100, 250, 500].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}{size === 500 ? " (large)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">per page</span>
          </div>
        </div>

        {isOpen && (
          <div id="plate-database-search-options" className="mt-4 border-t pt-4">
            <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-5">
              <div className="relative sm:col-span-2">
                <Label htmlFor="plate-database-search" className="sr-only">
                  Plate, known name, or notes
                </Label>
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="plate-database-search"
                  value={filters.search}
                  onChange={(event) => onChange({ search: event.target.value })}
                  placeholder="Search plates, names, or notes..."
                  className="h-9 pl-9 dark:bg-[#161618]"
                />
              </div>
              <div>
                <Label htmlFor="plate-database-match-mode" className="sr-only">Plate matching</Label>
                <PlateMatchModeSelect
                  id="plate-database-match-mode"
                  value={filters.matchMode}
                  onValueChange={(matchMode) => onChange({ matchMode })}
                  settings={matchingSettings}
                  prefixLabel="Plate matching"
                  ariaLabel="Plate matching"
                  className="h-9 w-full"
                />
              </div>
              <div>
                <Label htmlFor="plate-database-tag" className="sr-only">Tags</Label>
                <MultiSelectFilter
                  id="plate-database-tag"
                  ariaLabel="Filter plate database by tags"
                  allLabel="All tags"
                  value={filters.tags}
                  options={tagOptions}
                  exclusiveValues={["untagged"]}
                  onChange={(tags) => onChange({ tags })}
                  className="h-9 w-full dark:bg-[#161618]"
                />
              </div>
              <div>
                <Label htmlFor="plate-database-camera" className="sr-only">Cameras</Label>
                <MultiSelectFilter
                  id="plate-database-camera"
                  ariaLabel="Filter plate database by cameras"
                  allLabel="All cameras"
                  value={filters.cameraNames}
                  options={cameraOptions}
                  onChange={(cameraNames) => onChange({ cameraNames })}
                  className="h-9 w-full dark:bg-[#161618]"
                />
              </div>
              <LiveFeedDateRangeFilter
                value={selectedDateRange}
                onChange={handleDateRangeChange}
                triggerClassName="w-full justify-start"
                mobileVisible
              />
              <FilterHourRange
                value={filters.hourRange}
                onChange={(hourRange) => onChange({ hourRange })}
                timeFormat={timeFormat}
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex min-h-8 flex-wrap items-center gap-2">
        {hasActiveFilters && (
          <>
            <span className="whitespace-nowrap text-xs text-muted-foreground">Active filters:</span>
            {filters.search.trim() && <Badge variant="outline">Search: {filters.search.trim()}</Badge>}
            {filters.tags.length > 0 && <Badge variant="outline">Tags: {filters.tags.join(", ")}</Badge>}
            {filters.cameraNames.length > 0 && <Badge variant="outline">Cameras: {filters.cameraNames.join(", ")}</Badge>}
            {(filters.dateRange.from || filters.dateRange.to) && (
              <Badge variant="outline">Date: {filters.dateRange.from || "Any"} - {filters.dateRange.to || "Any"}</Badge>
            )}
            {filters.hourRange && (
              <Badge variant="outline">Hours: {filters.hourRange.from} - {filters.hourRange.to}</Badge>
            )}
            <Button variant="outline" size="sm" onClick={onClear} className="h-6 gap-1 px-2 text-xs">
              <X className="h-3.5 w-3.5" /> Clear filters
            </Button>
          </>
        )}

        {can("export.create") && (
          <Button variant="secondary" asChild className="ml-auto">
            <Link href={exportHref(filters, sortConfig)}>
              <Download className="mr-2 h-4 w-4" /> Export these results
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
