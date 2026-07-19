import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import PlateExportForm from "@/components/PlateExportForm";
import { getCameraNames, getPlateViewSettings, getTags } from "@/app/actions";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function DownloadPage() {
  await requirePagePermission("export.create");
  const [tagsResult, camerasResult, settings] = await Promise.all([
    getTags(),
    getCameraNames(),
    getPlateViewSettings(),
  ]);

  return (
    <DashboardLayout>
      <TitleNavbar title="Downloads">
        <PlateExportForm
          tags={tagsResult.success ? tagsResult.data : []}
          cameras={camerasResult.success ? camerasResult.data : []}
          matchingSettings={settings.plateMatching}
        />
      </TitleNavbar>
    </DashboardLayout>
  );
}
