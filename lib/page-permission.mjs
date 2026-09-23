import { redirect } from "next/navigation";

import { getCurrentAccess } from "@/app/actions";

export async function requirePagePermission(permission) {
  const access = await getCurrentAccess();
  if (!access.permissions.includes(permission)) {
    redirect("/forbidden");
  }
  return access;
}
