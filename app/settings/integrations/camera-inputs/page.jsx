import { CameraInputs } from "@/components/settings/CameraInputs";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";
export default async function CameraInputsPage() {
  await requirePagePermission("system.manage_settings");
  return <CameraInputs />;
}
