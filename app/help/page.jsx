import DashboardLayout from "@/components/layout/MainLayout";
import HelpManual from "@/components/help/HelpManual";
import { HELP_MANUAL } from "@/lib/help-manual.mjs";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function HelpPage() {
  await requirePagePermission("plate.read");

  return (
    <DashboardLayout>
      <HelpManual manual={HELP_MANUAL} />
    </DashboardLayout>
  );
}
