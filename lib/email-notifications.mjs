import nodemailer from "nodemailer";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function deliveryError(message, { retryable = true, code = "" } = {}) {
  const error = new Error(message);
  error.retryable = retryable;
  if (code) error.code = code;
  return error;
}

export function normalizeEmailRecipients(value, { maximum = 10 } = {}) {
  const candidates = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[;,\n]/);
  const recipients = [...new Set(candidates.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean))];
  if (recipients.length === 0) throw new Error("Enter at least one email recipient");
  if (recipients.length > maximum || recipients.some((entry) => entry.length > 254 || !EMAIL_PATTERN.test(entry))) {
    throw new Error(`Enter no more than ${maximum} valid email recipients`);
  }
  return recipients;
}

export function emailConfigurationState(config = {}) {
  const host = String(config.host ?? "").trim();
  const fromAddress = String(config.from_address ?? "").trim().toLowerCase();
  const username = String(config.username ?? "").trim();
  const password = String(config.password ?? "");
  const port = Number(config.port ?? 587);
  const authenticationComplete = Boolean(username) === Boolean(password);
  return {
    enabled: Boolean(config.enabled),
    configured: Boolean(
      host && EMAIL_PATTERN.test(fromAddress) && Number.isInteger(port) && port >= 1 && port <= 65535 && authenticationComplete
    ),
  };
}

function smtpTransport(config = {}, transportFactory = nodemailer.createTransport) {
  const state = emailConfigurationState(config);
  if (!state.enabled) throw deliveryError("Email notifications are disabled", { retryable: true, code: "EMAIL_DISABLED" });
  if (!state.configured) throw deliveryError("Email configuration is incomplete", { retryable: true, code: "EMAIL_NOT_CONFIGURED" });
  const username = String(config.username ?? "").trim();
  return transportFactory({
    host: String(config.host).trim(),
    port: Number(config.port),
    secure: Boolean(config.secure),
    ...(username ? { auth: { user: username, pass: String(config.password ?? "") } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    tls: { rejectUnauthorized: config.verify_tls !== false },
  });
}

function defaultMessage(payload = {}) {
  if (payload.eventType === "camera.activity_check") {
    return payload.message || `${payload.ruleName || "Camera activity rule"} matched for ${payload.cameraName || "a camera"}.`;
  }
  const known = payload.knownName ? ` (${payload.knownName})` : "";
  return payload.message || `Plate ${payload.plateNumber || "Unknown"}${known} was detected by ${payload.cameraName || "an ALPR camera"}.`;
}

function fromHeader(config = {}) {
  const address = String(config.from_address ?? "").trim();
  const name = String(config.from_name ?? "").trim();
  return name ? { name, address } : address;
}

export async function sendEmailNotification({
  config = {},
  payload = {},
  attachment = null,
  transportFactory = nodemailer.createTransport,
} = {}) {
  const recipients = normalizeEmailRecipients(payload.recipients);
  const transport = smtpTransport(config, transportFactory);
  const subject = String(payload.subject || payload.title || "ALPR notification")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 200);
  try {
    const result = await transport.sendMail({
      from: fromHeader(config),
      to: recipients,
      subject,
      text: defaultMessage(payload),
      ...(attachment ? {
        attachments: [{
          filename: `${String(payload.plateNumber || "alpr-notification").replace(/[^A-Za-z0-9_-]/g, "_")}.jpg`,
          content: attachment,
          contentType: "image/jpeg",
        }],
      } : {}),
      headers: {
        "X-ALPR-Event-ID": String(payload.eventId || "manual-test").slice(0, 255),
      },
    });
    return {
      messageId: String(result.messageId || "").slice(0, 500),
      accepted: (result.accepted || []).map(String).slice(0, 20),
      rejected: (result.rejected || []).map(String).slice(0, 20),
      response: String(result.response || "").slice(0, 1000),
    };
  } catch (cause) {
    const responseCode = Number(cause?.responseCode);
    const permanent = responseCode >= 500 && responseCode < 600;
    throw deliveryError(
      String(cause?.message || "SMTP delivery failed").slice(0, 2000),
      { retryable: !permanent, code: String(cause?.code || "SMTP_ERROR") }
    );
  } finally {
    transport.close?.();
  }
}

export const emailNotificationInternals = Object.freeze({
  EMAIL_PATTERN,
  defaultMessage,
  deliveryError,
  fromHeader,
  smtpTransport,
});
