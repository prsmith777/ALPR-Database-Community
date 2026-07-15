import { cookies } from "next/headers";
import { getAuthConfig, updateAuthConfig, verifySession } from "@/lib/auth";
import { getAgents } from "@/lib/settings";
import { createChatRouteHandler } from "@/lib/chat-route.mjs";

async function readSessionId() {
  const cookieStore = await cookies();
  return cookieStore.get("session")?.value || null;
}

export const POST = createChatRouteHandler({
  readSessionId,
  verifySession,
  getAgents,
  getAuthConfig,
  updateAuthConfig,
});
