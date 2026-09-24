"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

export function useHydrationSafeTimeZone() {
  const isHydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
  return isHydrated ? undefined : "UTC";
}

export function formatHydrationSafeDateTime(
  value,
  { fallback = "Not available", timeZone, options = {} } = {}
) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString("en-US", {
    ...options,
    ...(timeZone ? { timeZone } : {}),
  });
}
