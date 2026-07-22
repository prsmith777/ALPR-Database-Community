"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { applyDisabledNotificationRuleMigration } from "@/app/actions";
import { Button } from "@/components/ui/button";

export function ApplyNotificationMigrationButton({ pendingCount = 0, migratedCount = 0 }) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState(null);
  const [isPending, startTransition] = useTransition();

  if (pendingCount === 0) {
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
        <p className="font-medium">Disabled unified copies are up to date</p>
        <p className="mt-1 text-muted-foreground">
          {migratedCount} ready source {migratedCount === 1 ? "rule has" : "rules have"} an
          idempotently tracked disabled copy. Existing delivery remains unchanged.
        </p>
      </div>
    );
  }

  function applyMigration() {
    setMessage(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("confirmation", "create_disabled_rules");
      const result = await applyDisabledNotificationRuleMigration(formData);
      if (!result.success) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      const { createdCount, skippedCount, blockedCount } = result.data;
      setConfirmed(false);
      setMessage({
        kind: "success",
        text: `Created ${createdCount} disabled ${createdCount === 1 ? "rule" : "rules"}; ${skippedCount} already existed and ${blockedCount} remained blocked.`,
      });
      router.refresh();
    });
  }

  return (
    <div className="rounded-md border p-4 space-y-3">
      <div>
        <p className="font-medium">Create disabled unified copies</p>
        <p className="mt-1 text-sm text-muted-foreground">
          This creates {pendingCount} review-only {pendingCount === 1 ? "rule" : "rules"}. It
          does not enable unified delivery and does not change or disable the existing Pushover
          or MQTT paths.
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <span>I understand the copied rules will remain disabled pending review.</span>
      </label>
      <Button type="button" disabled={!confirmed || isPending} onClick={applyMigration}>
        {isPending
          ? "Creating disabled rules..."
          : `Create ${pendingCount} disabled ${pendingCount === 1 ? "rule" : "rules"}`}
      </Button>
      {message && (
        <p
          role="status"
          className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-emerald-700 dark:text-emerald-300"}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
