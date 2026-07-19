import { getKnownPlatesList } from "@/app/actions";
import { KnownPlatesTable } from "@/components/KnownPlatesTable";
import DashboardLayout from "@/components/layout/MainLayout";
import BasicTitle from "@/components/layout/BasicTitle";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function KnownPlatesPage() {
  await requirePagePermission("plate.read");
  const response = await getKnownPlatesList();
  const knownPlates = response.success ? response.data : [];
  const loadError = response.success
    ? null
    : response.error || "Unable to load known plates.";

  return (
    <DashboardLayout>
      <BasicTitle
        title="Known Plates"
        subtitle={
          "Store information and keep track of vehicles you're familiar with"
        }
      >
        {loadError ? (
          <Alert variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        ) : (
          <KnownPlatesTable initialData={knownPlates} />
        )}
      </BasicTitle>
    </DashboardLayout>
  );
}
