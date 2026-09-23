"use client";

import { FlaggedPlatesTable } from "@/components/FlaggedPlatesTable";
import { KnownPlatesTable } from "@/components/KnownPlatesTable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRouteTab } from "@/components/useRouteTab";

export function KnownPlatesWorkspace({
  knownPlates,
  monitoredPlates,
}) {
  const routeTab = useRouteTab({
    known: "/known_plates",
    monitored: "/known_plates/monitored",
  }, "known");

  return (
    <Tabs
      value={routeTab.active}
      onValueChange={routeTab.navigate}
      className="mt-4"
    >
      <TabsList aria-label="Plate management views" className="h-auto flex-wrap">
        <TabsTrigger value="known">
          Known Plates ({knownPlates.length})
        </TabsTrigger>
        <TabsTrigger value="monitored">
          Monitored Plates ({monitoredPlates.length})
        </TabsTrigger>
      </TabsList>
      <TabsContent value="known">
        <KnownPlatesTable initialData={knownPlates} />
      </TabsContent>
      <TabsContent value="monitored">
        <FlaggedPlatesTable initialData={monitoredPlates} />
      </TabsContent>
    </Tabs>
  );
}
