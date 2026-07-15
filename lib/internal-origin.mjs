const DEFAULT_INTERNAL_PORT = "3000";
const ALLOWED_INTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

function parseConfiguredOrigin(configuredValue) {
  if (typeof configuredValue !== "string" || configuredValue.trim() === "") {
    throw new TypeError("Invalid internal origin");
  }

  let configuredUrl;
  try {
    configuredUrl = new URL(configuredValue);
  } catch {
    throw new TypeError("Invalid internal origin");
  }

  if (!ALLOWED_INTERNAL_PROTOCOLS.has(configuredUrl.protocol)) {
    throw new TypeError("Invalid internal origin");
  }

  if (
    configuredUrl.username ||
    configuredUrl.password ||
    configuredValue.includes("?") ||
    configuredValue.includes("#")
  ) {
    throw new TypeError("Invalid internal origin");
  }

  return configuredUrl.origin;
}

function getLoopbackOrigin(env) {
  const port = String(env?.PORT || DEFAULT_INTERNAL_PORT);
  if (!/^\d+$/.test(port)) throw new TypeError("Invalid internal port");

  const numericPort = Number(port);
  if (numericPort < 1 || numericPort > 65535) {
    throw new TypeError("Invalid internal port");
  }

  return new URL(`http://127.0.0.1:${numericPort}`).origin;
}

export function getTrustedInternalOrigin(env = process.env) {
  if (env?.ALPR_INTERNAL_ORIGIN !== undefined) {
    return parseConfiguredOrigin(env.ALPR_INTERNAL_ORIGIN);
  }

  return getLoopbackOrigin(env);
}

export function getTrustedInternalUrl(pathname, env = process.env) {
  return new URL(pathname, `${getTrustedInternalOrigin(env)}/`);
}
