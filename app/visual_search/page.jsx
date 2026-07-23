import { getVisualSearchBootstrap } from "@/app/actions";
import VisualSearch from "@/components/VisualSearch";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function VisualSearchPage({ searchParams }) {
  await requirePagePermission("plate.read");
  const parameters = await searchParams;
  const bootstrap = await getVisualSearchBootstrap();

  return (
    <DashboardLayout>
      <TitleNavbar title="Visual Search" navigation={[]}>
        <VisualSearch
          initialResult={bootstrap}
          initialReadId={parameters?.readId || ""}
        />
      </TitleNavbar>
    </DashboardLayout>
  );
}
