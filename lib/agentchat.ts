"use server";

import { cookies } from "next/headers";
import type { StructuredData, Agent } from "@/lib/agentchat-utils";
import { getAuthConfig, getSessionPrincipal } from "@/lib/auth";
import { hasPermission } from "@/lib/identity-service.mjs";

async function canUseAssistant(): Promise<boolean> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get("session")?.value;
  if (!sessionId) return false;
  const principal = await getSessionPrincipal(sessionId);
  return hasPermission(principal, "assistant.use");
}

// Agent Management
export async function getAvailableAgents(): Promise<{
  success: boolean;
  data?: Agent[];
  error?: string;
}> {
  try {
    if (!(await canUseAssistant())) {
      return { success: false, error: "AI Assistant is unavailable." };
    }

    const config = await getAuthConfig();
    const agents = config.agents || [];

    const availableAgents = agents.filter((agent: Agent) => agent.enabled);

    return {
      success: true,
      data: availableAgents,
    };
  } catch (error) {
    console.error("Error getting agents:", error);
    return { success: false, error: "Failed to get agents" };
  }
}

// Cache agents to avoid repeated lookups
let agentsCache: { data: Agent[]; timestamp: number } | null = null;
const AGENTS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getCachedAgents(): Promise<Agent[]> {
  const now = Date.now();

  if (agentsCache && now - agentsCache.timestamp < AGENTS_CACHE_TTL) {
    return agentsCache.data;
  }

  const result = await getAvailableAgents();
  if (result.success && result.data) {
    agentsCache = {
      data: result.data,
      timestamp: now,
    };
    return result.data;
  }

  return [];
}

// Chat API Communication
export async function sendChatMessage(
  message: string,
  agentId: string,
  timezone: string = "UTC"
): Promise<{
  success: boolean;
  response?: string;
  structured?: StructuredData;
  agentTitle?: string;
  error?: string;
}> {
  try {
    if (!(await canUseAssistant())) {
      return { success: false, error: "AI Assistant is unavailable." };
    }

    const agents = await getCachedAgents();
    if (!agents.length) {
      return { success: false, error: "No agents available" };
    }

    const selectedAgent = agents.find((agent) => agent.id === agentId);
    if (!selectedAgent) {
      return { success: false, error: "Agent not found" };
    }

    const response = await fetch(selectedAgent.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chatInput: message,
        timezone: timezone,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Try to parse as JSON first, fall back to plain text
    let responseData;
    let responseText;

    try {
      const text = await response.text();
      responseText = text;
      responseData = JSON.parse(text);
    } catch (jsonError) {
      // If JSON parsing fails, treat as plain text response
      responseData = { response: responseText };
    }

    return {
      success: true,
      response: responseData.response || responseData.output || responseText,
      structured: responseData.structured,
      agentTitle: selectedAgent.title,
    };
  } catch {
    console.error("AI agent request failed");
    return {
      success: false,
      error: "The configured AI agent is unavailable.",
    };
  }
}
