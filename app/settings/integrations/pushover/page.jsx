import { getSettings } from "@/app/actions";
import { PushoverSettings } from "@/components/settings/IntegrationChannelSettings";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function PushoverIntegrationPage() {
  await requirePagePermission("system.manage_settings");
  return <PushoverSettings settings={await getSettings()} />;
}
