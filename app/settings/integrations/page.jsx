import { redirect } from "next/navigation";

import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  await requirePagePermission("system.manage_settings");
  redirect("/settings/integrations/mqtt");
}
