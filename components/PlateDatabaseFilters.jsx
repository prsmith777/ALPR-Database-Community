"use client";

import Link from "next/link";
import { Download, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

function exportHref(filters, sortConfig) {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.fuzzySearch) params.set("fuzzySearch", "true");
  if (filters.tag !== "all") params.set("tag", filters.tag);
  if (filters.cameraName) params.set("camera", filters.cameraName);
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
}) {
  const hourFrom = filters.hourRange ? String(filters.hourRange.from) : "all";
  const hourTo = filters.hourRange ? String(filters.hourRange.to) : "all";
  const updateHour = (side, value) => {
    if (value === "all") {
      onChange({ hourRange: null });
      return;
    }
    const current = filters.hourRange || { from: 0, to: 23 };
    onChange({ hourRange: { ...current, [side]: Number(value) } });
  };

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="plate-database-search">Plate, known name, or notes</Label>
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              id="plate-database-search"
              value={filters.search}
              onChange={(event) => onChange({ search: event.target.value })}
              placeholder="Search the plate database"
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="plate-database-fuzzy"
              checked={filters.fuzzySearch}
              onCheckedChange={(checked) => onChange({ fuzzySearch: checked })}
            />
            <Label htmlFor="plate-database-fuzzy" className="text-sm font-normal">
              Include close plate matches
            </Label>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="plate-database-tag">Tag</Label>
          <Select value={filters.tag} onValueChange={(tag) => onChange({ tag })}>
            <SelectTrigger id="plate-database-tag"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tags</SelectItem>
              <SelectItem value="untagged">Untagged</SelectItem>
              {availableTags.map((tag) => (
                <SelectItem key={tag.name} value={tag.name}>{tag.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="plate-database-camera">Camera</Label>
          <Select
            value={filters.cameraName || "all"}
            onValueChange={(camera) => onChange({ cameraName: camera === "all" ? "" : camera })}
          >
            <SelectTrigger id="plate-database-camera"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cameras</SelectItem>
              {availableCameras.map((camera) => (
                <SelectItem key={camera} value={camera}>{camera}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="plate-date-from">Seen on or after</Label>
          <Input
            id="plate-date-from"
            type="date"
            value={filters.dateRange.from}
            onChange={(event) => onChange({ dateRange: { ...filters.dateRange, from: event.target.value } })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="plate-date-to">Seen on or before</Label>
          <Input
            id="plate-date-to"
            type="date"
            value={filters.dateRange.to}
            onChange={(event) => onChange({ dateRange: { ...filters.dateRange, to: event.target.value } })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="plate-database-hour-from">First hour</Label>
          <Select value={hourFrom} onValueChange={(value) => updateHour("from", value)}>
            <SelectTrigger id="plate-database-hour-from"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any time</SelectItem>
              {HOURS.map((hour) => <SelectItem key={hour} value={String(hour)}>{hourLabel(hour)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="plate-database-hour-to">Last hour</Label>
          <Select value={hourTo} onValueChange={(value) => updateHour("to", value)}>
            <SelectTrigger id="plate-database-hour-to"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any time</SelectItem>
              {HOURS.map((hour) => <SelectItem key={hour} value={String(hour)}>{hourLabel(hour)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center">
        <Button variant="outline" onClick={onClear}>
          <X className="mr-2 h-4 w-4" /> Clear filters
        </Button>
        <Button variant="secondary" asChild>
          <Link href={exportHref(filters, sortConfig)}>
            <Download className="mr-2 h-4 w-4" /> Export these results
          </Link>
        </Button>
        <div className="flex items-center gap-2 sm:ml-auto">
          <Label htmlFor="plate-database-page-size" className="whitespace-nowrap text-sm font-normal">Rows per page</Label>
          <Select value={String(pageSize)} onValueChange={onPageSizeChange}>
            <SelectTrigger id="plate-database-page-size" className="w-24"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[10, 25, 50, 100].map((size) => (
                <SelectItem key={size} value={String(size)}>{size}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
