import { getVehicleClusterOverview } from "@/app/actions";
import VehicleClusters from "@/components/VehicleClusters";
import DashboardLayout from "@/components/layout/MainLayout";
import TitleNavbar from "@/components/layout/TitleNav";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const navigation = [
  { title: "Visual Search", href: "/visual_search", permission: "plate.read" },
  { title: "Vehicle Profiles", href: "/visual_search/vehicles", permission: "plate.read" },
  { title: "Needs Review", href: "/visual_search/vehicles/review", permission: "plate.read" },
];

function positivePage(value) {
  return Math.max(1, Number.parseInt(value, 10) || 1);
}

function reviewQueue(value, canManageSettings) {
  if (["vehicle", "plates", "direction"].includes(value)) return value;
  if (value === "setup" && canManageSettings) return value;
  return "vehicle";
}

export default async function VehicleReviewPage({ searchParams }) {
  await requirePagePermission("plate.read");
  const parameters = await searchParams;
  const result = await getVehicleClusterOverview({
    vehicleReviewPage: positivePage(parameters?.vehicleReviewPage),
    plateReviewPage: positivePage(parameters?.plateReviewPage),
    directionReviewPage: positivePage(parameters?.directionReviewPage),
  });
  const queue = reviewQueue(parameters?.queue, result?.success && result.data.canManageSettings);
  return (
    <DashboardLayout>
      <TitleNavbar title="Vehicle Intelligence" navigation={navigation}>
        <VehicleClusters initialResult={result} view="review" initialQueue={queue} />
      </TitleNavbar>
    </DashboardLayout>
  );
}
