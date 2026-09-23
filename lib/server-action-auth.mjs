export const AUTHENTICATION_REQUIRED_MESSAGE = "Authentication required";
export const AUTHENTICATION_UNAVAILABLE_MESSAGE =
  "Authentication service unavailable";

export function createServerActionAuthenticator({
  readSessionId,
  verifySession,
  logger = console,
}) {
  return async function requireAuthenticatedSession() {
    let sessionId;
    try {
      sessionId = await readSessionId();
    } catch {
      logger.error("Server action authentication unavailable");
      throw new Error(AUTHENTICATION_UNAVAILABLE_MESSAGE);
    }

    if (!sessionId) throw new Error(AUTHENTICATION_REQUIRED_MESSAGE);

    let valid;
    try {
      valid = await verifySession(sessionId);
    } catch {
      logger.error("Server action authentication unavailable");
      throw new Error(AUTHENTICATION_UNAVAILABLE_MESSAGE);
    }

    if (!valid) throw new Error(AUTHENTICATION_REQUIRED_MESSAGE);
    return valid;
  };
}
