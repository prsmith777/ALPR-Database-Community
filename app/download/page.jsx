import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import PlateExportForm from "@/components/PlateExportForm";
import {
  getCameraNames,
  getPlateViewSettings,
  getTags,
  getTimeFormat,
} from "@/app/actions";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function DownloadPage() {
  await requirePagePermission("export.create");
  const [tagsResult, camerasResult, settings, timeFormat] = await Promise.all([
    getTags(),
    getCameraNames(),
    getPlateViewSettings(),
    getTimeFormat(),
  ]);

  return (
    <DashboardLayout>
      <TitleNavbar title="Downloads">
        <PlateExportForm
          tags={tagsResult.success ? tagsResult.data : []}
          cameras={camerasResult.success ? camerasResult.data : []}
          matchingSettings={settings.plateMatching}
          timeFormat={timeFormat}
        />
      </TitleNavbar>
    </DashboardLayout>
  );
}
