import { getFlagged, getKnownPlatesList } from "@/app/actions";
import { KnownPlatesWorkspace } from "@/components/KnownPlatesWorkspace";
import DashboardLayout from "@/components/layout/MainLayout";
import BasicTitle from "@/components/layout/BasicTitle";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function KnownPlatesPage({ searchParams }) {
  await requirePagePermission("plate.read");
  const [response, monitoredPlates, params] = await Promise.all([
    getKnownPlatesList(),
    getFlagged(),
    searchParams,
  ]);
  const knownPlates = response.success ? response.data : [];
  const loadError = response.success
    ? null
    : response.error || "Unable to load known plates.";

  return (
    <DashboardLayout>
      <BasicTitle
        title="Known Plates"
        subtitle="Manage known identities and monitored vehicles in one place"
      >
        {loadError ? (
          <Alert variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        ) : (
          <KnownPlatesWorkspace
            knownPlates={knownPlates}
            monitoredPlates={monitoredPlates}
            defaultView={params?.view === "monitored" ? "monitored" : "known"}
          />
        )}
      </BasicTitle>
    </DashboardLayout>
  );
}
