export const SESSION_COOKIE_NAME = "session";
export const SESSION_EXPIRATION_SECONDS = 24 * 60 * 60;

function getSessionCookieSecure() {
  return process.env.SESSION_COOKIE_SECURE === "true";
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: getSessionCookieSecure(),
    sameSite: "lax",
    maxAge: SESSION_EXPIRATION_SECONDS,
    path: "/",
  };
}

export function getSessionCookieDeletionOptions() {
  return {
    httpOnly: true,
    secure: getSessionCookieSecure(),
    sameSite: "lax",
    maxAge: 0,
    expires: new Date(0),
    path: "/",
  };
}
