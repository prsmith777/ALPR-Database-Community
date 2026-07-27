"use client";

import { usePathname, useRouter } from "next/navigation";

export function useRouteTab(routes, fallback) {
  const pathname = usePathname();
  const router = useRouter();
  const active = Object.entries(routes).find(([, href]) => href === pathname)?.[0] || fallback;

  return {
    active,
    navigate(value) {
      const href = routes[value];
      if (href && href !== pathname) router.push(href, { scroll: false });
    },
  };
}
