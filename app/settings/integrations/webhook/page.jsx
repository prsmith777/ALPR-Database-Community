import { getSettings } from "@/app/actions";
import { WebhookSettings } from "@/components/settings/IntegrationChannelSettings";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function WebhookIntegrationPage() {
  await requirePagePermission("system.manage_settings");
  return <WebhookSettings settings={await getSettings()} />;
}
