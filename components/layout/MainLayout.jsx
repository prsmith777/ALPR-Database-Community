import { Sidebar } from "@/components/Sidebar";
import { getCurrentAccess } from "@/app/actions";

export default async function DashboardLayout({ children }) {
  const access = await getCurrentAccess();
  return (
    <div className="relative flex h-screen bg-background">
      <Sidebar permissions={access.permissions} />
      <main className="flex-1 overflow-y-auto pb-32 sm:pb-0">{children}</main>
    </div>
  );
}
