import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import PlateDbTable from "@/components/plateDbTable";
import { getPlates, getPlateViewSettings } from "@/app/actions";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function Database() {
  await requirePagePermission("plate.read");
  let plateReads = [];
  const settings = await getPlateViewSettings();

  if (typeof window !== "undefined") {
    // Stop this from trying to connect during build
    plateReads = await getPlates(1, 25, {
      key: "last_seen_at",
      direction: "desc",
    });
  }

  return (
    <DashboardLayout>
      <TitleNavbar title="Plate Database">
        <PlateDbTable
          initialData={plateReads}
          matchingSettings={settings.plateMatching}
        />
      </TitleNavbar>
    </DashboardLayout>
  );
}
