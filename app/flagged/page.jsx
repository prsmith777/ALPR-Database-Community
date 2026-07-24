import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function FlaggedPlatesPage() {
  await requirePagePermission("plate.read");
  redirect("/known_plates?view=monitored");
}
