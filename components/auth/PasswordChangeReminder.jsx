"use client";

import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";

import { useAccess } from "@/components/auth/AccessProvider";
import { Button } from "@/components/ui/button";

export function PasswordChangeReminder() {
  const router = useRouter();
  const { currentUser, ready } = useAccess();
  const passwordChangeRequired =
    ready &&
    currentUser?.authMode === "named" &&
    currentUser?.mustChangePassword === true;

  if (!passwordChangeRequired) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-3 border-b border-amber-500/40 bg-amber-50 px-4 py-3 text-amber-950 shadow-sm dark:bg-amber-950 dark:text-amber-50"
    >
      <KeyRound className="h-5 w-5 shrink-0" />
      <p className="text-sm font-medium">
        Change your temporary password before continuing.
      </p>
      <Button
        type="button"
        size="sm"
        onClick={() => router.push("/settings/security")}
      >
        Change password
      </Button>
    </div>
  );
}
