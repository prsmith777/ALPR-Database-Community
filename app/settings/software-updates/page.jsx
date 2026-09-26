import { SettingsShell } from "@/components/settings/SettingsShell";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import { readCommunityUpdateControlSnapshot } from "@/lib/community-update-control.mjs";
import { getReleaseInfo } from "@/lib/release-info.mjs";

import SoftwareUpdatesPanel from "./SoftwareUpdatesPanel";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SoftwareUpdatesPage() {
  await requirePagePermission("maintenance.manage");
  const snapshot = await readCommunityUpdateControlSnapshot();
  return (
    <SettingsShell
      activeId="softwareUpdates"
      title="Software Updates"
      description="Follow the guided check, install, Technical system checks, and acceptance workflow for exact ALPR Community releases."
    >
      <SoftwareUpdatesPanel initialSnapshot={snapshot} release={getReleaseInfo()} />
    </SettingsShell>
  );
}
