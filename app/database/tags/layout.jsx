import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function TagManagementLayout({ children }) {
  await requirePagePermission("tag.manage");
  return children;
}
