"use client";

import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const rangeFromValue = (value) => ({
  from: value?.from ? new Date(value.from) : undefined,
  to: value?.to ? new Date(value.to) : undefined,
});

export default function LiveFeedDateRangeFilter({
  value,
  onChange,
  embedded = false,
}) {
  const fromMs = value?.from?.getTime?.() ?? null;
  const toMs = value?.to?.getTime?.() ?? null;
  const [draft, setDraft] = useState(() => rangeFromValue(value));

  useEffect(() => {
    setDraft(rangeFromValue(value));
  }, [fromMs, toMs, value]);

  const handleSelect = useCallback((range) => {
    const nextRange = range || {};
    setDraft(nextRange);
    if (!range) {
      onChange(null);
      return;
    }
    if (!nextRange.from || !nextRange.to) return;
    onChange(nextRange);
  }, [onChange]);

  const calendar = (
    <Calendar
      initialFocus={!embedded}
      mode="range"
      defaultMonth={draft?.from}
      selected={draft}
      onSelect={handleSelect}
      numberOfMonths={embedded ? 1 : 2}
      fixedWeeks={!embedded}
      className={embedded ? "rounded-md border" : undefined}
    />
  );

  if (embedded) return calendar;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="hidden gap-2 dark:bg-[#161618] sm:flex"
        >
          <CalendarDays className="h-4 w-4" />
          {value?.from ? (
            value.to ? (
              <>
                {format(value.from, "LLL dd")} - {format(value.to, "LLL dd")}
              </>
            ) : (
              format(value.from, "LLL dd")
            )
          ) : (
            "Date Range"
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="max-h-[var(--radix-popover-content-available-height)] w-[520px] overflow-y-auto overscroll-contain p-0"
        align="start"
        collisionPadding={16}
        sticky="always"
      >
        {calendar}
      </PopoverContent>
    </Popover>
  );
}
