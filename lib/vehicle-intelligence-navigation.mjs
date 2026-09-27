export const VEHICLE_INTELLIGENCE_NAVIGATION = Object.freeze([
  { title: "Vehicle Search", href: "/visual_search", permission: "plate.read" },
  { title: "Profiles", href: "/visual_search/profiles", permission: "plate.read" },
  { title: "Needs Review", href: "/visual_search/review", permission: "plate.read" },
]);

export function vehicleIntelligenceNavigationForMode() {
  return VEHICLE_INTELLIGENCE_NAVIGATION;
}
