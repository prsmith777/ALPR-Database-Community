import { notFound } from "next/navigation";

import SettingsSectionPage from "../SettingsSectionPage";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SECTION_IDS = Object.freeze({
  general: "general",
  database: "database",
  "plate-matching": "plateMatching",
  "review-corrections": "plateReview",
  security: "security",
  "data-privacy": "privacy",
  release: "release",
  "blue-iris": "blueiris",
  "home-assistant": "homeassistant",
});

export default async function DedicatedSettingsPage({ params }) {
  const sectionId = SECTION_IDS[String((await params)?.section || "")];
  if (!sectionId) notFound();
  return <SettingsSectionPage sectionId={sectionId} />;
}
