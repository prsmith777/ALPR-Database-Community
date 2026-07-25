import Link from "next/link";
import { Antenna, ArrowRight, BellRing, Mail, Webhook } from "lucide-react";

import { getSettings } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePagePermission } from "@/lib/page-permission.mjs";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  await requirePagePermission("system.manage_settings");
  const settings = await getSettings();
  const pushover = settings.notifications?.pushover || {};
  const email = settings.notifications?.email || {};
  const webhook = settings.notifications?.webhook || {};
  const integrations = [
    {
      title: "MQTT",
      description: "Brokers, per-camera topics, connection tests, and delivery activity.",
      href: "/settings/integrations/mqtt",
      icon: Antenna,
      status: "Open setup",
      ready: null,
    },
    {
      title: "Pushover",
      description: "Mobile push alerts with account usage and delivery defaults.",
      href: "/settings/integrations/pushover",
      icon: BellRing,
      status: pushover.enabled && pushover.appTokenConfigured && pushover.userKeyConfigured ? "Ready" : "Needs setup",
      ready: pushover.enabled && pushover.appTokenConfigured && pushover.userKeyConfigured,
    },
    {
      title: "Email",
      description: "SMTP server, sender identity, TLS policy, and a direct test.",
      href: "/settings/integrations/email",
      icon: Mail,
      status: email.enabled && email.host && email.from_address ? "Ready" : "Needs setup",
      ready: email.enabled && email.host && email.from_address,
    },
    {
      title: "Webhook",
      description: "Signed JSON callbacks with private-network and HTTP safety controls.",
      href: "/settings/integrations/webhook",
      icon: Webhook,
      status: webhook.enabled && webhook.signingSecretConfigured ? "Ready" : "Needs setup",
      ready: webhook.enabled && webhook.signingSecretConfigured,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-muted/20 p-5">
        <h2 className="font-semibold">Configuration lives here; automation lives in Notification Rules</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Set up and test each delivery service below. Then create rules that decide when and where alerts are sent.
        </p>
        <Link href="/notifications" className="mt-3 inline-flex items-center text-sm font-medium text-primary hover:underline">
          Open Notification Rules <ArrowRight className="ml-1 h-4 w-4" />
        </Link>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {integrations.map((integration) => {
          const Icon = integration.icon;
          return (
            <Link key={integration.href} href={integration.href} className="group">
              <Card className="h-full transition-colors group-hover:border-primary/50 group-hover:bg-muted/20">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="rounded-lg border bg-background p-2"><Icon className="h-5 w-5" /></div>
                    <Badge variant={integration.ready ? "default" : "secondary"}>{integration.status}</Badge>
                  </div>
                  <CardTitle className="pt-2">{integration.title}</CardTitle>
                  <CardDescription>{integration.description}</CardDescription>
                </CardHeader>
                <CardContent className="flex items-center text-sm font-medium text-primary">
                  Configure {integration.title} <ArrowRight className="ml-1 h-4 w-4 transition-transform group-hover:translate-x-1" />
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
