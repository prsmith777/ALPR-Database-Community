const COOKIE_PATH = "/";
const COOKIE_SAME_SITE = "lax";

export function isSessionCookieSecure() {
  const value = process.env.SESSION_COOKIE_SECURE;

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return false;
}

export function getSessionCookieOptions(extraOptions = {}) {
  return {
    secure: isSessionCookieSecure(),
    sameSite: COOKIE_SAME_SITE,
    path: COOKIE_PATH,
    ...extraOptions,
  };
}
