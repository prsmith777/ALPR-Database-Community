import { cookies } from "next/headers";
import { getSessionPrincipal } from "@/lib/auth";
import { getAgents } from "@/lib/settings";
import { hasPermission } from "@/lib/identity-service.mjs";
import { createChatRouteHandler } from "@/lib/chat-route.mjs";

async function readSessionId() {
  const cookieStore = await cookies();
  return cookieStore.get("session")?.value || null;
}

async function verifyAssistantSession(sessionId) {
  const principal = await getSessionPrincipal(sessionId);
  return hasPermission(principal, "assistant.use");
}

export const POST = createChatRouteHandler({
  readSessionId,
  verifySession: verifyAssistantSession,
  getAgents,
});
