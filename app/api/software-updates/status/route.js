import { readCommunityUpdateControlSnapshot } from "@/lib/community-update-control.mjs";
import { getReleaseInfo } from "@/lib/release-info.mjs";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = Object.freeze({ "Cache-Control": "no-store" });

export async function GET() {
  const denied = await denyUnlessRoutePermission("maintenance.manage");
  if (denied) {
    denied.headers.set("Cache-Control", "no-store");
    return denied;
  }

  try {
    const snapshot = await readCommunityUpdateControlSnapshot();
    const release = getReleaseInfo();
    return Response.json(
      {
        success: true,
        snapshot,
        release: {
          version: release.version,
          gitSha: release.gitSha,
        },
      },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("Unable to read Community software update status:", error);
    return Response.json(
      { success: false, error: "Unable to read software update status." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
