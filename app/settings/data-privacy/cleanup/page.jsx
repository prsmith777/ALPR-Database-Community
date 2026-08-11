import SettingsSectionPage from "../../SettingsSectionPage";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function DataPrivacyCleanupPage() {
  return <SettingsSectionPage sectionId="privacy" privacyView="cleanup" />;
}
