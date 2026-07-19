import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function UpdateLayout({ children }) {
  await requirePagePermission("maintenance.manage");
  return children;
}
