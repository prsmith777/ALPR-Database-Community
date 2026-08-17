export const VEHICLE_INTELLIGENCE_LEGACY_NAVIGATION = Object.freeze([
  { title: "Legacy Visual Search", href: "/visual_search", permission: "plate.read" },
  { title: "Legacy Profiles", href: "/visual_search/vehicles", permission: "plate.read" },
  { title: "Legacy Needs Review", href: "/visual_search/vehicles/review", permission: "plate.read" },
  { title: "ReID v2 Shadow", href: "/visual_search/reid-v2", permission: "plate.read" },
]);

export const VEHICLE_INTELLIGENCE_PRIMARY_NAVIGATION = Object.freeze([
  { title: "Vehicle Search", href: "/visual_search", permission: "plate.read" },
  { title: "Profiles", href: "/visual_search/profiles", permission: "plate.read" },
  { title: "Review", href: "/visual_search/review", permission: "plate.read" },
]);

export function vehicleIntelligenceNavigationForMode(mode) {
  return mode === "v2_primary"
    ? VEHICLE_INTELLIGENCE_PRIMARY_NAVIGATION
    : VEHICLE_INTELLIGENCE_LEGACY_NAVIGATION;
}

export const VEHICLE_INTELLIGENCE_NAVIGATION = VEHICLE_INTELLIGENCE_LEGACY_NAVIGATION;
