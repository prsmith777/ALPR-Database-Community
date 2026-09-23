import { BackfillButton } from "./BackfillButton";
import { dbBackfill } from "@/app/actions";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function BackfillPage() {
  await requirePagePermission("maintenance.manage");
  return (
    <div className="flex flex-col items-center justify-center h-screen">
      <h1 className="text-2xl font-bold">
        Backfill Occurrence Counts to New Column in Plates Table
      </h1>
      <BackfillButton dbBackfill={dbBackfill} />
    </div>
  );
}
