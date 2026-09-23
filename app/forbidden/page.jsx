import Link from "next/link";
import { ShieldX } from "lucide-react";

import DashboardLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";

export default function ForbiddenPage() {
  return (
    <DashboardLayout>
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="max-w-md space-y-4 text-center">
          <ShieldX className="mx-auto h-12 w-12 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Access denied</h1>
          <p className="text-muted-foreground">
            Your account does not have permission to open this page.
          </p>
          <Button asChild>
            <Link href="/dashboard">Return to dashboard</Link>
          </Button>
        </div>
      </div>
    </DashboardLayout>
  );
}
