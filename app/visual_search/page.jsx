import { getVisualSearchBootstrap } from "@/app/actions";
import VisualSearch from "@/components/VisualSearch";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import { VEHICLE_INTELLIGENCE_NAVIGATION } from "@/lib/vehicle-intelligence-navigation.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function VisualSearchPage({ searchParams }) {
  await requirePagePermission("plate.read");
  const parameters = await searchParams;
  const bootstrap = await getVisualSearchBootstrap();

  return (
    <DashboardLayout>
      <TitleNavbar title="Vehicle Intelligence" navigation={VEHICLE_INTELLIGENCE_NAVIGATION}>
        <VisualSearch
          initialResult={bootstrap}
          initialReadId={parameters?.readId || ""}
        />
      </TitleNavbar>
    </DashboardLayout>
  );
}
