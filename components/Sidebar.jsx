"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Antenna,
  BellPlus,
  BookMarked,
  Cctv,
  Database,
  Flag,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  TerminalSquare,
  X,
} from "lucide-react";

import { logoutAction } from "@/app/actions";
import { ChatButton } from "@/components/chat/ChatButton";
import { useAccess } from "@/components/auth/AccessProvider";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const allNavItems = [
  { icon: LayoutDashboard, label: "Dashboard", href: "/dashboard", permission: "plate.read" },
  { icon: Cctv, label: "Live Feed", href: "/live_feed", permission: "plate.read" },
  { icon: Database, label: "Database", href: "/database", permission: "plate.read" },
  { icon: BookMarked, label: "Known Plates", href: "/known_plates", permission: "plate.read" },
  { icon: Flag, label: "Watchlist", href: "/flagged", permission: "plate.read" },
  { icon: BellPlus, label: "Notifications", href: "/notifications", permission: "notification.manage" },
  { icon: Antenna, label: "MQTT", href: "/mqtt", permission: "mqtt.manage" },
];

const mobileNavItems = [
  { icon: LayoutDashboard, label: "Dashboard", href: "/dashboard", permission: "plate.read" },
  { icon: Cctv, label: "Live Feed", href: "/live_feed", permission: "plate.read" },
  { icon: Database, label: "Database", href: "/database", permission: "plate.read" },
  { icon: BookMarked, label: "Plates", href: "/known_plates", permission: "plate.read" },
  { icon: Menu, label: "More", href: "#more" },
];

export function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const { can: canAccess } = useAccess();

  const navItems = allNavItems.filter((item) => canAccess(item.permission));
  const visibleMobileNavItems = mobileNavItems.filter((item) =>
    canAccess(item.permission)
  );
  const canViewAudit = canAccess("system.view_audit");

  const navigateTo = (href) => {
    if (href === "#more") {
      setIsSheetOpen(true);
      return;
    }
    router.push(href);
    setIsSheetOpen(false);
  };

  const isPathActive = (path) => {
    if (path === "/dashboard") {
      return pathname === "/dashboard" || pathname === "/";
    }
    return pathname === path || pathname.startsWith(`${path}/`);
  };

  return (
    <>
      <TooltipProvider>
        <aside className="hidden h-screen w-14 flex-col justify-between border-r bg-background sm:flex">
          <nav className="flex flex-col items-center space-y-2 pt-4">
            {navItems.map((item) => (
              <Tooltip key={item.href} delayDuration={0}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    onClick={() => router.push(item.href)}
                    aria-label={item.label}
                    className={cn(
                      "h-10 w-10 p-0 hover:bg-transparent [&:not(:disabled)]:hover:bg-transparent",
                      isPathActive(item.href)
                        ? "text-blue-500"
                        : "hover:text-blue-500"
                    )}
                  >
                    <item.icon className="h-5 w-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" className="border-0 bg-muted">
                  {item.label}
                </TooltipContent>
              </Tooltip>
            ))}
          </nav>

          <div className="flex flex-col items-center space-y-2 pb-4">
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <ThemeToggle />
              </TooltipTrigger>
              <TooltipContent side="right" className="border-0 bg-muted">
                Toggle theme
              </TooltipContent>
            </Tooltip>
            <ChatButton />
            {canViewAudit && (
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  onClick={() => router.push("/logs")}
                  aria-label="System Logs"
                  className={cn(
                    "h-10 w-10 p-0 hover:bg-transparent [&:not(:disabled)]:hover:bg-transparent",
                    isPathActive("/logs")
                      ? "text-blue-500"
                      : "hover:text-blue-500"
                  )}
                >
                  <TerminalSquare className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className="border-0 bg-muted">
                System Logs
              </TooltipContent>
            </Tooltip>
            )}

            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  onClick={() => router.push("/settings")}
                  aria-label="Settings"
                  className={cn(
                    "h-10 w-10 p-0 hover:bg-transparent [&:not(:disabled)]:hover:bg-transparent",
                    isPathActive("/settings")
                      ? "text-blue-500"
                      : "hover:text-blue-500"
                  )}
                >
                  <Settings className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className="border-0 bg-muted">
                Settings
              </TooltipContent>
            </Tooltip>

            <form action={logoutAction}>
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <Button
                    type="submit"
                    variant="ghost"
                    aria-label="Log Out"
                    className="h-10 w-10 p-0 hover:bg-transparent hover:text-red-500 [&:not(:disabled)]:hover:bg-transparent"
                  >
                    <LogOut className="h-5 w-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" className="border-0 bg-muted">
                  Log Out
                </TooltipContent>
              </Tooltip>
            </form>
          </div>
        </aside>
      </TooltipProvider>

      <nav className="fixed bottom-0 left-0 right-0 z-50 flex h-24 items-center justify-around border-t bg-background pb-4 sm:hidden">
        {visibleMobileNavItems.map((item) => (
          <Button
            key={item.href}
            variant="ghost"
            size="sm"
            onClick={() => navigateTo(item.href)}
            className={cn(
              "flex h-full w-full flex-col items-center justify-center rounded-none px-0 py-1",
              pathname === item.href
                ? "text-blue-500"
                : "text-muted-foreground"
            )}
          >
            <item.icon className="mb-1 h-5 w-5" />
            <span className="text-[10px]">{item.label}</span>
          </Button>
        ))}
      </nav>

      <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen}>
        <SheetContent side="bottom" className="h-[80vh] px-0 pt-0">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-3">
            <SheetTitle className="text-lg font-semibold">Menu</SheetTitle>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsSheetOpen(false)}
              className="h-8 w-8"
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>

          <div className="max-h-[calc(80vh-60px)] space-y-1 overflow-y-auto px-2 py-4">
            {navItems.map((item) => (
              <Button
                key={item.href}
                variant="ghost"
                className={cn(
                  "h-12 w-full justify-start px-4 text-left",
                  isPathActive(item.href)
                    ? "bg-muted text-blue-500"
                    : "text-foreground"
                )}
                onClick={() => navigateTo(item.href)}
              >
                <item.icon className="mr-3 h-5 w-5" />
                {item.label}
              </Button>
            ))}

            <div className="my-4 h-px bg-border" />

            {canViewAudit && (
            <Button
              variant="ghost"
              className={cn(
                "h-12 w-full justify-start px-4 text-left",
                isPathActive("/logs")
                  ? "bg-muted text-blue-500"
                  : "text-foreground"
              )}
              onClick={() => navigateTo("/logs")}
            >
              <TerminalSquare className="mr-3 h-5 w-5" />
              System Logs
            </Button>
            )}

            <Button
              variant="ghost"
              className={cn(
                "h-12 w-full justify-start px-4 text-left",
                isPathActive("/settings")
                  ? "bg-muted text-blue-500"
                  : "text-foreground"
              )}
              onClick={() => navigateTo("/settings")}
            >
              <Settings className="mr-3 h-5 w-5" />
              Settings
            </Button>

            <form action={logoutAction}>
              <Button
                type="submit"
                variant="ghost"
                className="h-12 w-full justify-start px-4 text-left text-red-500 hover:text-red-500"
              >
                <LogOut className="mr-3 h-5 w-5" />
                Log Out
              </Button>
            </form>

            <div className="mt-4 px-4 py-2">
              <div className="flex items-center">
                <span className="mr-auto">Theme</span>
                <ThemeToggle />
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <div className="h-16 sm:hidden" />
    </>
  );
}
