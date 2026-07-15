import { getOwnValidSession } from "./session-validation.mjs";

function jsonError(message, status, extra = {}) {
  return Response.json({ error: message, ...extra }, { status });
}

export function createChatRouteHandler({
  readSessionId,
  verifySession,
  getAgents,
  getAuthConfig,
  updateAuthConfig,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  return async function chatRoute(request) {
    let sessionId;
    try {
      sessionId = await readSessionId();
      if (!sessionId) return jsonError("Authentication required", 401);

      if (!(await verifySession(sessionId))) {
        return jsonError("Invalid session", 401);
      }
    } catch {
      logger.error("Chat authentication unavailable");
      return jsonError("Authentication service unavailable", 503);
    }

    let requestBody;
    try {
      requestBody = await request.json();
    } catch {
      return jsonError("Invalid request body", 400);
    }

    try {
      const { message, timezone, agentId } = requestBody;

      if (!message) return jsonError("Message is required", 400);
      if (!agentId) return jsonError("Agent ID is required", 400);

      const agents = await getAgents();
      const selectedAgent = agents.find(
        (agent) => agent.id === agentId && agent.enabled
      );

      if (!selectedAgent) {
        return jsonError("Agent not found or disabled", 404);
      }

      const config = await getAuthConfig();
      const userSession = getOwnValidSession(config.sessions, sessionId);
      if (!userSession) return jsonError("Invalid session", 401);

      const agentSessionKey = `${agentId}_sessionId`;
      let agentSessionId = userSession[agentSessionKey] || null;

      const isTimeRelated =
        /\b(time|hour|am|pm|morning|afternoon|evening|night|today|yesterday|when|schedule|late|early)\b/i.test(
          message
        );

      const requestPayload = { chatInput: message };

      if (isTimeRelated && timezone) {
        const currentTime = new Date().toISOString();
        const userLocalTime = new Date().toLocaleString("en-US", {
          timeZone: timezone,
        });

        requestPayload.timezone = timezone;
        requestPayload.currentTime = currentTime;
        requestPayload.userLocalTime = userLocalTime;
        requestPayload.timeInstructions = `IMPORTANT: Query the database timezone first using 'SELECT current_setting('timezone')' or 'SELECT now()'. Then calculate time offsets. For example, if user mentions '3am' and they're in ${timezone}, convert that to the database timezone for your queries. This avoids expensive SQL timezone conversions on large datasets.`;
      }

      if (agentSessionId) requestPayload.sessionId = agentSessionId;

      const response = await fetchImpl(selectedAgent.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });

      if (!response.ok) {
        logger.error(`Remote agent request failed with status ${response.status}`);
        return jsonError("Remote agent request failed", 500, {
          status: response.status,
        });
      }

      const newAgentSessionId = response.headers.get("x-session-id");
      const responseBody = await response.text();

      let agentMessage;
      let structuredData = null;

      try {
        const parsedResponse = JSON.parse(responseBody);

        if (parsedResponse.agentMessage) {
          agentMessage = parsedResponse.agentMessage;
          structuredData = parsedResponse.structuredData || null;
        } else if (parsedResponse.response && parsedResponse.structured) {
          agentMessage = parsedResponse.response;
          structuredData = parsedResponse.structured;
        } else if (parsedResponse.output) {
          agentMessage = parsedResponse.output;
          structuredData = null;
        } else if (typeof parsedResponse === "string") {
          agentMessage = parsedResponse;
        } else {
          agentMessage =
            parsedResponse.message ||
            parsedResponse.text ||
            parsedResponse.content ||
            JSON.stringify(parsedResponse);
        }
      } catch {
        agentMessage = responseBody;
      }

      if (structuredData && typeof structuredData === "object") {
        const validTypes = [
          "chart",
          "known_plates",
          "table",
          "metrics",
          "timeline",
          "tags",
          "code",
          "image",
          "images",
        ];
        if (!structuredData.type || !validTypes.includes(structuredData.type)) {
          logger.warn("Remote agent returned unsupported structured data");
          structuredData = null;
        }
      }

      if (newAgentSessionId && newAgentSessionId !== agentSessionId) {
        userSession[agentSessionKey] = newAgentSessionId;
        agentSessionId = newAgentSessionId;
        await updateAuthConfig(config);
      }

      return Response.json({
        response: agentMessage || "No response received",
        timestamp: new Date().toISOString(),
        structured: structuredData,
        agentId,
        agentTitle: selectedAgent.title,
      });
    } catch {
      logger.error("Chat request processing failed");
      return jsonError("Unable to process chat request", 500);
    }
  };
}
