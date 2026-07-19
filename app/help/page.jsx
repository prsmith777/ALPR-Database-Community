import DashboardLayout from "@/components/layout/MainLayout";
import Link from "next/link";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requirePagePermission("maintenance.manage");
  return (
    <DashboardLayout>
      <div className="w-full h-screen py-48 flex justify-center font-mono ">
        <div className="border border-secondary-foreground rounded-lg p-8 flex flex-col gap-12 max-w-screen-xl">
          <div className="border-b dark:border-white/80">
            <h1 className="text-3xl font-semibold mb-4">
              Major Changes - Jan 20
            </h1>
          </div>
          <h1 className="text-xl font-semibold">
            Something broken? See below for development update and how to fix.{" "}
          </h1>
          <div className="flex flex-col gap-6">
            <p>
              Several changes have been made that will greatly improve the
              performance and reliability of the application. A full update
              release will be coming soon with a more automated upgrade process,
              but I am embedding this quick guide in the meantime for any early
              adopters.
            </p>
            <p>
              There are two major changes in the database that will require some
              quick manual action to transform your existing data.
            </p>
            <div className="flex flex-col pl-4 pb-8">
              <span className="text-lg font-semibold">
                - Filesystem Image Storage
              </span>
              <span className="text-lg font-semibold">
                - Explicit Occurrence Count Tracking
              </span>
            </div>
            <h2 className="text-lg font-semibold">
              To Migrate Your Existing Data:
            </h2>
            <ol className="list-decimal list-inside space-y-2">
              <li>
                Ensure you have the latest docker-compose.yml and migrations.sql
                files.
              </li>
              <li>
                Create a new directory called &quot;storage&quot; in the same
                place as your auth and config directories. This is where JPEGs
                will now be stored.
              </li>
              <li>
                Backfill the new occurrence_count column.{" "}
                <Link
                  className="text-blue-500"
                  target="_blank"
                  href="/backfill"
                >
                  This page
                </Link>{" "}
                has a tool that will count them up and fill in the records for
                you.
              </li>
              <li>
                Convert and transfer all your old base64 images to the new
                filesystem storage. You can do that with{" "}
                <Link
                  className="text-blue-500"
                  target="_blank"
                  href="/jpeg_migration"
                >
                  this tool.
                </Link>{" "}
              </li>
              <li>
                Visit the settings page to set your retention preferences. The
                database is wildly faster now and can handle a very large number
                of records. You will likely want to increase your max records
                value. I am setting the default for new users at 100 thousand.
              </li>
            </ol>
            <p className="pt-8">
              Thank you to everyone reporting bugs and leaving suggestions.
            </p>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
