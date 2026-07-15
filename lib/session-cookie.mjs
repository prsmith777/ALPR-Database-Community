export const SESSION_COOKIE_NAME = "session";
export const SESSION_MAX_AGE_SECONDS = 86400;

export function getSessionCookieOptions(env = process.env) {
  return {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE === "true",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export function getSessionCookieDeletionOptions(env = process.env) {
  return {
    ...getSessionCookieOptions(env),
    maxAge: 0,
    expires: new Date(0),
  };
}

export function setSessionCookie(cookieStore, sessionId, env = process.env) {
  cookieStore.set(
    SESSION_COOKIE_NAME,
    sessionId,
    getSessionCookieOptions(env)
  );
}

export function clearSessionCookie(cookieStore, env = process.env) {
  cookieStore.set(
    SESSION_COOKIE_NAME,
    "",
    getSessionCookieDeletionOptions(env)
  );
}
