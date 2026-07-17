"use client";

import { Camera, ListFilter, Network, TestTube2 } from "lucide-react";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

import { MqttActivity } from "./MqttActivity";
import { MqttBrokers } from "./MqttBrokers";
import { MqttCameras } from "./MqttCameras";
import { MqttRules } from "./MqttRules";

export function MqttAdmin() {
  return (
    <Tabs defaultValue="brokers" className="space-y-6">
      <TabsList className="grid h-auto w-full grid-cols-2 gap-1 p-1 lg:grid-cols-4">
        <TabsTrigger value="brokers" className="gap-2 py-2">
          <Network className="h-4 w-4" />
          Brokers
        </TabsTrigger>
        <TabsTrigger value="cameras" className="gap-2 py-2">
          <Camera className="h-4 w-4" />
          Cameras & Topics
        </TabsTrigger>
        <TabsTrigger value="rules" className="gap-2 py-2">
          <ListFilter className="h-4 w-4" />
          Rules
        </TabsTrigger>
        <TabsTrigger value="activity" className="gap-2 py-2">
          <TestTube2 className="h-4 w-4" />
          Test & Activity
        </TabsTrigger>
      </TabsList>

      <TabsContent value="brokers" className="mt-0">
        <MqttBrokers />
      </TabsContent>
      <TabsContent value="cameras" className="mt-0">
        <MqttCameras />
      </TabsContent>
      <TabsContent value="rules" className="mt-0">
        <MqttRules />
      </TabsContent>
      <TabsContent value="activity" className="mt-0">
        <MqttActivity />
      </TabsContent>
    </Tabs>
  );
}
