"use client";

import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export default function MultiSelectFilter({
  id,
  ariaLabel,
  allLabel,
  value = [],
  options = [],
  onChange,
  exclusiveValues = [],
  className,
}) {
  const selected = Array.isArray(value) ? value : [];

  const toggleValue = (optionValue) => {
    if (selected.includes(optionValue)) {
      onChange(selected.filter((item) => item !== optionValue));
      return;
    }

    if (exclusiveValues.includes(optionValue)) {
      onChange([optionValue]);
      return;
    }

    onChange([
      ...selected.filter((item) => !exclusiveValues.includes(item)),
      optionValue,
    ]);
  };

  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? options.find((option) => option.value === selected[0])?.label || selected[0]
        : `${selected.length} selected`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          className={cn("justify-between font-normal", className)}
        >
          <span className="truncate">{summary}</span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted"
          onClick={() => onChange([])}
        >
          <Check className={cn("h-4 w-4", selected.length === 0 ? "opacity-100" : "opacity-0")} />
          {allLabel}
        </button>
        <div className="max-h-64 overflow-y-auto">
          {options.map((option) => {
            const isSelected = selected.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted",
                  isSelected && "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                )}
                onClick={() => toggleValue(option.value)}
              >
                <Check className={cn("h-4 w-4", isSelected ? "opacity-100" : "opacity-0")} />
                {option.color && (
                  <span
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: option.color }}
                    aria-hidden="true"
                  />
                )}
                <span className="truncate">{option.label}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
