"use client";

import { useState, useTransition } from "react";
import { BellRing, MailCheck, Webhook } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function NotificationChannelTestPanel({ options = {} }) {
  const [samplePlate, setSamplePlate] = useState("TEST123");
  const [email, setEmail] = useState("");
  const [webhook, setWebhook] = useState("");
  const [message, setMessage] = useState(null);
  const [isPending, startTransition] = useTransition();
  const pushoverReady = options.pushoverEnabled && options.pushoverConfigured;
  const emailReady = options.emailEnabled && options.emailConfigured;
  const webhookReady = options.webhookEnabled && options.webhookConfigured;

  function send(channelType, destination) {
    setMessage(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/notifications/channels/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelType, destination }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || "Test delivery failed");
        setMessage({ kind: "success", text: result.message });
      } catch (error) {
        setMessage({ kind: "error", text: String(error?.message || "Test delivery failed") });
      }
    });
  }

  return <Card>
    <CardHeader>
      <CardTitle>Test notification channels</CardTitle>
      <CardDescription>Send a direct test after saving channel settings. Tests do not create or evaluate a plate rule.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-[auto_1fr_auto] lg:items-center">
        <Badge variant={pushoverReady ? "default" : "secondary"}>Pushover {pushoverReady ? "ready" : "not ready"}</Badge>
        <Input value={samplePlate} onChange={(event) => setSamplePlate(event.target.value.toUpperCase())} placeholder="TEST123" aria-label="Pushover sample plate" maxLength={16} />
        <Button type="button" variant="outline" disabled={isPending || !pushoverReady || !samplePlate.trim()} onClick={() => send("pushover", samplePlate)}><BellRing className="mr-2 h-4 w-4" />Send test Pushover</Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-[auto_1fr_auto] lg:items-center">
        <Badge variant={emailReady ? "default" : "secondary"}>Email {emailReady ? "ready" : "not ready"}</Badge>
        <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="recipient@example.com" aria-label="Test email recipient" />
        <Button type="button" variant="outline" disabled={isPending || !emailReady || !email.trim()} onClick={() => send("email", email)}><MailCheck className="mr-2 h-4 w-4" />Send test email</Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-[auto_1fr_auto] lg:items-center">
        <Badge variant={webhookReady ? "default" : "secondary"}>Webhook {webhookReady ? "ready" : "not ready"}</Badge>
        <Input type="url" value={webhook} onChange={(event) => setWebhook(event.target.value)} placeholder="https://automation.example.com/alpr" aria-label="Test webhook URL" />
        <Button type="button" variant="outline" disabled={isPending || !webhookReady || !webhook.trim()} onClick={() => send("webhook", webhook)}><Webhook className="mr-2 h-4 w-4" />Send test webhook</Button>
      </div>
      {message && <p className={`rounded-md border p-3 text-sm ${message.kind === "error" ? "border-destructive/50 text-destructive" : "border-emerald-500/50 text-emerald-700 dark:text-emerald-300"}`}>{message.text}</p>}
    </CardContent>
  </Card>;
}
