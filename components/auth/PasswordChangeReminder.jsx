"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";

import { useAccess } from "@/components/auth/AccessProvider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function PasswordChangeReminder() {
  const router = useRouter();
  const { currentUser, ready } = useAccess();
  const [dismissed, setDismissed] = useState(false);
  const passwordChangeRequired =
    ready &&
    currentUser?.authMode === "named" &&
    currentUser?.mustChangePassword === true;

  const goToPasswordSettings = () => {
    setDismissed(true);
    router.push("/settings");
  };

  return (
    <Dialog
      open={passwordChangeRequired && !dismissed}
      onOpenChange={(open) => {
        if (!open) setDismissed(true);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            Change your temporary password
          </DialogTitle>
          <DialogDescription>
            You signed in with a temporary password. Change it now under
            Settings &gt; Security to protect your account.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setDismissed(true)}>
            Remind me later
          </Button>
          <Button type="button" onClick={goToPasswordSettings}>
            Change password now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
