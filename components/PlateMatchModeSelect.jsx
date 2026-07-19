"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { plateMatchModeLabel } from "@/lib/plate-matching.mjs";

const MODES = ["default", "off", "strict", "balanced", "broad"];

export default function PlateMatchModeSelect({
  id,
  value = "default",
  onValueChange,
  settings,
  className,
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} className={className}>
        <SelectValue />
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
