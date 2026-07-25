"use client";

import { usePathname } from "next/navigation";

import { SettingsShell } from "@/components/settings/SettingsShell";

const pageDetails = {
  "/settings/integrations": {
    id: "integrations",
    title: "Integrations",
    description: "Connect ALPR Database to the services that deliver alerts and automation events.",
  },
  "/settings/integrations/mqtt": {
    id: "mqtt",
    title: "MQTT",
    description: "Configure brokers and camera topics, send a test message, and review delivery activity.",
  },
  "/settings/integrations/pushover": {
    id: "pushover",
    title: "Pushover",
    description: "Configure mobile push delivery, review monthly usage, and send a test alert.",
  },
  "/settings/integrations/email": {
    id: "email",
    title: "Email",
    description: "Configure SMTP delivery, sender identity, transport security, and test recipients.",
  },
  "/settings/integrations/webhook": {
    id: "webhook",
    title: "Webhook",
    description: "Configure signed JSON delivery and the network-safety policy for webhook targets.",
  },
};

export function IntegrationsLayoutShell({ children }) {
  const pathname = usePathname();
  const details = pageDetails[pathname] || pageDetails["/settings/integrations"];
  return <SettingsShell activeId={details.id} title={details.title} description={details.description}>{children}</SettingsShell>;
}
