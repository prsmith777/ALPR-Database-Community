"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Antenna,
  Bell,
  CarFront,
  Database,
  Home,
  Lock,
  Mail,
  PackageOpen,
  PanelLeftClose,
  PanelLeftOpen,
  ScanSearch,
  Server,
  Settings2,
  Shield,
  ShieldCheck,
  Webhook,
} from "lucide-react";

import DashboardLayout from "@/components/layout/MainLayout";
import { useAccess } from "@/components/auth/AccessProvider";
import { cn } from "@/lib/utils";

const navigationSections = [
  {
    title: "System",
    permission: "system.manage_settings",
    items: [
      { title: "General", id: "general", href: "/settings/general", icon: Settings2 },
      { title: "Database", id: "database", href: "/settings/database", icon: Database },
      { title: "Plate Matching", id: "plateMatching", href: "/settings/plate-matching", icon: ScanSearch },
      { title: "Review & Corrections", id: "plateReview", href: "/settings/review-corrections", icon: ShieldCheck },
      { title: "Vehicle Setup", id: "vehicleIntelligence", href: "/settings/vehicle-intelligence", icon: CarFront },
      { title: "Data & Privacy", id: "privacy", href: "/settings/data-privacy", icon: Shield },
      { title: "Release", id: "release", href: "/settings/release", icon: PackageOpen },
    ],
  },
  {
    title: "Account",
    items: [
      { title: "Security", id: "security", href: "/settings/security", icon: Lock },
    ],
  },
  {
    title: "Integrations",
    items: [
      { title: "MQTT", id: "mqtt", href: "/settings/integrations/mqtt", icon: Antenna, permission: "mqtt.manage" },
      { title: "Pushover", id: "pushover", href: "/settings/integrations/pushover", icon: Bell, permission: "system.manage_settings" },
      { title: "Email", id: "email", href: "/settings/integrations/email", icon: Mail, permission: "system.manage_settings" },
      { title: "Webhook", id: "webhook", href: "/settings/integrations/webhook", icon: Webhook, permission: "system.manage_settings" },
      { title: "Blue Iris", id: "blueiris", href: "/settings/blue-iris", icon: Server, permission: "system.manage_settings" },
      { title: "Home Assistant", id: "homeassistant", href: "/settings/home-assistant", icon: Home, permission: "system.manage_settings" },
    ],
  },
];

function SettingsShellContent({ activeId, title, description, children }) {
  const { can } = useAccess();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    setSidebarCollapsed(window.localStorage.getItem("settings-sidebar-collapsed") === "true");
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("settings-sidebar-collapsed", String(next));
      return next;
    });
  };
  const visibleSections = navigationSections
    .filter((section) => !section.permission || can(section.permission))
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !item.permission || can(item.permission)),
    }))
    .filter((section) => section.items.length > 0);

  return (
      <div className="flex min-h-full bg-background">
        <aside className={cn("hidden flex-shrink-0 border-r border-border bg-background transition-[width] lg:block", sidebarCollapsed ? "w-16" : "w-56")}>
          <div className={cn("border-b border-border", sidebarCollapsed ? "p-3" : "p-4")}>
            <div className="flex items-center justify-between gap-2">
              {!sidebarCollapsed ? (
                <div className="flex min-w-0 items-center gap-3">
                  <Settings2 className="h-6 w-6 text-primary" />
                  <h1 className="text-xl font-semibold">Settings</h1>
                </div>
              ) : null}
              <button type="button" onClick={toggleSidebar} className={cn("rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground", sidebarCollapsed && "mx-auto")} aria-label={sidebarCollapsed ? "Expand Settings sidebar" : "Collapse Settings sidebar"}>
                {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <nav className={cn("space-y-6", sidebarCollapsed ? "p-2" : "p-3")} aria-label="Settings navigation">
            {visibleSections.map((section) => (
              <div key={section.title} className="space-y-2">
                <h2 className={cn("px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground", sidebarCollapsed && "sr-only")}>
                  {section.title}
                </h2>
                <div className="space-y-1">
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    const classes = cn(
                      "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors",
                      item.id === activeId
                        ? "border border-blue-500/20 bg-blue-500/10 text-blue-600"
                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                    );
                    return (
                      <Link key={item.id} href={item.href} className={cn(classes, sidebarCollapsed && "justify-center px-2")} title={sidebarCollapsed ? item.title : undefined} aria-label={sidebarCollapsed ? item.title : undefined}>
                        <Icon className="h-4 w-4 flex-shrink-0" />
                        {!sidebarCollapsed ? item.title : null}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="border-b border-border bg-background px-4 py-6 sm:px-8">
            <h1 className="text-2xl font-semibold">{title}</h1>
            {description ? <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
            <div className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
              {visibleSections.flatMap((section) => section.items).map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  className={cn(
                    "whitespace-nowrap rounded-md border px-3 py-2 text-sm",
                    item.id === activeId ? "border-primary bg-primary text-primary-foreground" : "bg-background"
                  )}
                >
                  {item.title}
                </Link>
              ))}
            </div>
          </header>
          <div className="p-4 sm:p-8">{children}</div>
        </section>
      </div>
  );
}

export function SettingsShell(props) {
  return (
    <DashboardLayout>
      <SettingsShellContent {...props} />
    </DashboardLayout>
  );
}

export const settingsNavigation = navigationSections;
