"use client";

import { useRouter } from "next/navigation";

import { FlaggedPlatesTable } from "@/components/FlaggedPlatesTable";
import { KnownPlatesTable } from "@/components/KnownPlatesTable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function KnownPlatesWorkspace({
  knownPlates,
  monitoredPlates,
  defaultView = "known",
}) {
  const router = useRouter();

  return (
    <Tabs
      defaultValue={defaultView}
      onValueChange={(view) =>
        router.replace(
          view === "monitored"
            ? "/known_plates?view=monitored"
            : "/known_plates",
          { scroll: false }
        )
      }
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
