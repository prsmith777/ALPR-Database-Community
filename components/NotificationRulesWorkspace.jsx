"use client";

import { Activity, ListChecks } from "lucide-react";

import { NotificationOperationsPanel } from "@/components/NotificationOperationsPanel";
import { NotificationRuleBuilder } from "@/components/NotificationRuleBuilder";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function NotificationRulesWorkspace({ builderOverview, operationsOverview }) {
  return (
    <div>
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
