"use client";

import React, { useState, useEffect, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { useAccess } from "@/components/auth/AccessProvider";

const defaultNavigation = [
    { title: "Database", href: "/database", permission: "plate.read" },
    { title: "Tags", href: "/database/tags", permission: "tag.manage" },
    { title: "Download", href: "/download", permission: "export.create" },
];

export default function Component({
  title = "Plate Database",
  navigation = defaultNavigation,
  children,
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useAccess();
  const visibleNavigation = useMemo(
    () => navigation.filter((item) => !item.permission || can(item.permission)),
    [can, navigation]
  );
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const index = visibleNavigation.findIndex((item) => item.href === pathname);
    setActiveIndex(index !== -1 ? index : 0);
  }, [pathname, visibleNavigation]);

  const handleNavClick = (href, index) => {
    setActiveIndex(index);
    router.push(href);
  };

  return (
    <div className="flex min-h-screen flex-col py-4 px-6">
      <header className="border-b backdrop-blur">
        <div className="container flex h-14 items-center">
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-semibold">{title}</h1>
          </div>
        </div>
        <nav className="container">
          <div className="flex space-x-6">
            {visibleNavigation.map((item, index) => (
              <div key={item.href} className="relative">
                <a
                  onClick={() => handleNavClick(item.href, index)}
                  className={`flex h-14 items-center text-sm font-medium transition-colors hover:text-blue-400 cursor-pointer ${
                    index === activeIndex ? "text-blue-500" : "text-gray-400"
                  }`}
                >
                  {item.title}
                </a>
                {index === activeIndex && (
                  <div
                    className="absolute bottom-0 left-0 h-0.5 bg-blue-500 transition-all duration-300 ease-in-out"
                    style={{ width: "100%" }}
                  />
                )}
              </div>
            ))}
          </div>
        </nav>
      </header>
      <div className="flex-1">
        <div className="py-6">{children}</div>
      </div>
    </div>
  );
}
