import { requirePagePermission } from "@/lib/page-permission.mjs";

export default async function UpdateLayout({ children }) {
  await requirePagePermission("maintenance.manage");
  return children;
}
