import { cookies } from "next/headers";

import { getSessionPrincipal } from "./auth.js";
import { hasPermission } from "./identity-service.mjs";
import { SESSION_COOKIE_NAME } from "./session-cookie.mjs";

export async function denyUnlessRoutePermission(permission) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const principal = token ? await getSessionPrincipal(token) : null;
  if (!principal) {
    return Response.json(
      { success: false, error: "Authentication required." },
      { status: 401 }
    );
  }
  if (!hasPermission(principal, permission)) {
    return Response.json(
      { success: false, error: "Permission denied." },
      { status: 403 }
    );
  }
  return null;
}
