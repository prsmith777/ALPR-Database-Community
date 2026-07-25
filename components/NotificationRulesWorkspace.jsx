"use client";

import Link from "next/link";
import { Activity, Antenna, ArrowRight, BellRing, ListChecks, Mail, Webhook } from "lucide-react";

import { NotificationOperationsPanel } from "@/components/NotificationOperationsPanel";
import { NotificationRuleBuilder } from "@/components/NotificationRuleBuilder";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function NotificationRulesWorkspace({ builderOverview, operationsOverview }) {
  const options = builderOverview?.options || {};
  const channels = [
    { name: "MQTT", href: "/settings/integrations/mqtt", icon: Antenna, ready: Boolean(options.mqttEnabled) },
    { name: "Pushover", href: "/settings/integrations/pushover", icon: BellRing, ready: Boolean(options.pushoverEnabled && options.pushoverConfigured) },
    { name: "Email", href: "/settings/integrations/email", icon: Mail, ready: Boolean(options.emailEnabled && options.emailConfigured) },
    { name: "Webhook", href: "/settings/integrations/webhook", icon: Webhook, ready: Boolean(options.webhookEnabled && options.webhookConfigured) },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {channels.map((channel) => {
          const Icon = channel.icon;
          return (
            <Link key={channel.name} href={channel.href} className="group flex items-center justify-between gap-3 rounded-lg border p-4 transition-colors hover:border-primary/50 hover:bg-muted/20">
              <div className="flex items-center gap-3"><Icon className="h-5 w-5" /><div><p className="font-medium">{channel.name}</p><Badge className="mt-1" variant={channel.ready ? "default" : "secondary"}>{channel.ready ? "Ready" : "Needs setup"}</Badge></div></div>
              <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1" />
            </Link>
          );
        })}
      </div>

      <Tabs defaultValue="rules" className="space-y-5">
        <TabsList className="grid h-auto w-full grid-cols-2 p-1 sm:w-[28rem]">
          <TabsTrigger value="rules" className="gap-2 py-2"><ListChecks className="h-4 w-4" />Rules</TabsTrigger>
          <TabsTrigger value="activity" className="gap-2 py-2"><Activity className="h-4 w-4" />Activity & delivery</TabsTrigger>
        </TabsList>
        <TabsContent value="rules" className="mt-0"><NotificationRuleBuilder overview={builderOverview} /></TabsContent>
        <TabsContent value="activity" className="mt-0"><NotificationOperationsPanel overview={operationsOverview} /></TabsContent>
      </Tabs>
    </div>
  );
}
