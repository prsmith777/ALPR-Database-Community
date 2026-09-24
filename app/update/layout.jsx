import { requirePagePermission } from "@/lib/page-permission.mjs";
import { checkUpdateStatus } from "@/lib/db";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function UpdateLayout({ children }) {
  await requirePagePermission("maintenance.manage");
  if (await checkUpdateStatus()) redirect("/dashboard");
  return children;
}
