import { getSettings } from "@/app/actions";
import { EmailSettings } from "@/components/settings/IntegrationChannelSettings";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function EmailIntegrationPage() {
  await requirePagePermission("system.manage_settings");
  return <EmailSettings settings={await getSettings()} />;
}
