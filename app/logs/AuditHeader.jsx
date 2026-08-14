import Link from "next/link";

import {
  PROJECT_NAME,
  PROJECT_RELEASES_URL,
} from "@/lib/project-info";
import { cn } from "@/lib/utils";

const sections = [
  { id: "logs", label: "Operational logs", href: "/logs" },
  { id: "receipts", label: "Ingress receipts", href: "/logs/receipts" },
];

export default function AuditHeader({ active, version }) {
  return (
    <div className="flex-shrink-0 border-b bg-background">
      <div className="flex h-16 items-center justify-between gap-4 px-6">
        <div className="flex min-w-0 items-center gap-4">
          <h1 className="shrink-0 text-lg font-medium text-foreground">System Logs</h1>
          <nav
            aria-label="System log sections"
            className="flex min-w-0 items-center gap-1 overflow-x-auto"
          >
            {sections.map((section) => (
              <Link
                key={section.id}
                href={section.href}
                aria-current={active === section.id ? "page" : undefined}
                className={cn(
                  "shrink-0 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                  active === section.id
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
              >
                {section.label}
              </Link>
            ))}
          </nav>
        </div>
        <a
          href={PROJECT_RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="hidden shrink-0 text-sm text-muted-foreground hover:text-foreground hover:underline lg:block"
        >
          {PROJECT_NAME} · v{version}
        </a>
      </div>
    </div>
  );
}
