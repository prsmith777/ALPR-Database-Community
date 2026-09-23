import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function JpegMigrationLayout({ children }) {
  await requirePagePermission("maintenance.manage");
  return children;
}
