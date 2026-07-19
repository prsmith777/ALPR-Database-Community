import { requirePagePermission } from "@/lib/page-permission.mjs";

export default async function TagManagementLayout({ children }) {
  await requirePagePermission("tag.manage");
  return children;
}
