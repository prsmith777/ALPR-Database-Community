"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { plateMatchModeLabel } from "@/lib/plate-matching.mjs";

const MODES = ["off", "strict", "balanced", "broad"];

export default function PlateMatchModeSelect({
  id,
  value = "balanced",
  onValueChange,
  settings,
  className,
  prefixLabel,
  ariaLabel,
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        id={id}
        aria-label={ariaLabel || prefixLabel}
        className={className}
      >
        {prefixLabel ? (
          <span className="flex min-w-0 items-center gap-3">
            <span className="mr-1 shrink-0 text-xs text-muted-foreground">
              {prefixLabel}:
            </span>
            <SelectValue />
          </span>
        ) : (
          <SelectValue />
        )}
      </SelectTrigger>
      <SelectContent>
        {MODES.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {plateMatchModeLabel(mode, settings)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
