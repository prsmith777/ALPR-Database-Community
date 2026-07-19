import { requirePagePermission } from "@/lib/page-permission.mjs";

export default async function JpegMigrationLayout({ children }) {
  await requirePagePermission("maintenance.manage");
  return children;
}
