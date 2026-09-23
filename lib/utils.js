import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function formatTimeRange(hour, timeFormat) {
  if (timeFormat === 24) {
    return `${String(hour).padStart(2, "0")}:00`;
  }

  const period = hour >= 12 ? "PM" : "AM";
  const adjustedHour = hour % 12 || 12;
  return `${adjustedHour}:00 ${period}`;
}
