import { Sidebar } from "@/components/Sidebar";
import { AccessProvider } from "@/components/auth/AccessProvider";
import { PasswordChangeReminder } from "@/components/auth/PasswordChangeReminder";

export default function DashboardLayout({ children }) {
  return (
    <AccessProvider>
      <PasswordChangeReminder />
      <div className="relative flex h-screen bg-background">
        <Sidebar />
        <main className="flex-1 overflow-y-auto pb-32 sm:pb-0">{children}</main>
      </div>
    </AccessProvider>
  );
}
