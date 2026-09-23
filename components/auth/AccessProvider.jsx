"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

const AccessContext = createContext({
  currentUser: null,
  permissions: [],
  ready: false,
});

export function AccessProvider({ children }) {
  const [access, setAccess] = useState({
    currentUser: null,
    permissions: [],
    ready: false,
  });

  useEffect(() => {
    let active = true;
    fetch("/api/current-access", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => {
        if (!active) return;
        setAccess({
          currentUser: result?.currentUser || null,
          permissions: Array.isArray(result?.permissions)
            ? result.permissions
            : [],
          ready: true,
        });
      })
      .catch(() => {
        if (active) {
          setAccess({ currentUser: null, permissions: [], ready: true });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const value = useMemo(
    () => ({
      ...access,
      can: (permission) => access.permissions.includes(permission),
    }),
    [access]
  );

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess() {
  return useContext(AccessContext);
}
