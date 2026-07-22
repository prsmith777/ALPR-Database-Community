"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { approveUnifiedNotificationRuleReview } from "@/app/actions";
import { Button } from "@/components/ui/button";

export function ApproveShadowReviewButton({ ruleId, disabled = false }) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState(null);
  const [isPending, startTransition] = useTransition();

  function approve() {
    setMessage(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("ruleId", String(ruleId));
      formData.set("confirmation", "approve_disabled_shadow_review");
      const result = await approveUnifiedNotificationRuleReview(formData);
      if (!result.success) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setConfirmed(false);
      setMessage({
        kind: "success",
        text: result.data.recorded
          ? "Approval recorded. The unified rule remains disabled."
          : "This exact evidence set was already approved.",
      });
      router.refresh();
    });
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled || isPending}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <span>I approve this shadow evidence; keep the rule and delivery disabled.</span>
      </label>
      <Button type="button" size="sm" disabled={disabled || !confirmed || isPending} onClick={approve}>
        {isPending ? "Recording approval..." : "Record administrator approval"}
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
