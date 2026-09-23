"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function hourLabel(hour, timeFormat) {
  if (timeFormat === 24) return `${String(hour).padStart(2, "0")}:00`;
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}${suffix}`;
}

export default function FilterHourRange({
  value = null,
  onChange,
  timeFormat = 12,
  triggerClassName = "",
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState({ from: null, to: null });
  const valueFrom = Number.isInteger(value?.from) ? value.from : null;
  const valueTo = Number.isInteger(value?.to) ? value.to : null;
  const hours = useMemo(
    () =>
      Array.from({ length: 24 }, (_, hour) => ({
        value: hour,
        label: hourLabel(hour, timeFormat),
      })),
    [timeFormat]
  );

  useEffect(() => {
    setDraft({ from: valueFrom, to: valueTo });
  }, [valueFrom, valueTo]);

  const hasRange = valueFrom !== null && valueTo !== null;
  const label = hasRange
    ? `${hourLabel(valueFrom, timeFormat)} - ${hourLabel(valueTo, timeFormat)}`
    : "Hour Range";

  const clear = () => {
    setDraft({ from: null, to: null });
    onChange(null);
    setIsOpen(false);
  };

  const apply = () => {
    if (!Number.isInteger(draft.from) || !Number.isInteger(draft.to)) return;
    onChange({ from: draft.from, to: draft.to });
    setIsOpen(false);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={`h-9 w-full justify-start gap-2 dark:bg-[#161618] ${triggerClassName}`}
        >
          <Clock className="h-4 w-4" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-4" align="start">
        <div className="space-y-4">
          <h4 className="font-medium">Filter by Hour</h4>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>From</Label>
              <Select
                value={draft.from === null ? undefined : String(draft.from)}
                onValueChange={(next) =>
                  setDraft((current) => ({ ...current, from: Number(next) }))
                }
              >
                <SelectTrigger><SelectValue placeholder="Start hour" /></SelectTrigger>
                <SelectContent>
                  {hours.map((hour) => (
                    <SelectItem key={hour.value} value={String(hour.value)}>
                      {hour.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>To</Label>
              <Select
                value={draft.to === null ? undefined : String(draft.to)}
                onValueChange={(next) =>
                  setDraft((current) => ({ ...current, to: Number(next) }))
                }
              >
                <SelectTrigger><SelectValue placeholder="End hour" /></SelectTrigger>
                <SelectContent>
                  {hours.map((hour) => (
                    <SelectItem key={hour.value} value={String(hour.value)}>
                      {hour.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={clear}>
              Clear
            </Button>
            <Button
              className="flex-1"
              onClick={apply}
              disabled={!Number.isInteger(draft.from) || !Number.isInteger(draft.to)}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
