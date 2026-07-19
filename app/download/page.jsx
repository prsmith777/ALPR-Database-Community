import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import PlateExportForm from "@/components/PlateExportForm";
import { getCameraNames, getSettings, getTags } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function DownloadPage() {
  const [tagsResult, camerasResult, settings] = await Promise.all([
    getTags(),
    getCameraNames(),
    getSettings(),
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
