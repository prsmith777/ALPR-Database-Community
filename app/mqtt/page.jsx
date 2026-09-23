import { redirect } from "next/navigation";

import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MqttPage() {
  await requirePagePermission("mqtt.manage");
  redirect("/settings/integrations/mqtt");
}
