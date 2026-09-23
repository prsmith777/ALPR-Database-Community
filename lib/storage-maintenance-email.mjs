import { normalizeEmailRecipients, sendEmailNotification } from "./email-notifications.mjs";

export async function deliverStorageMaintenanceEmailTest({
  recipients,
  applicationConfig = {},
  sendEmail = sendEmailNotification,
  now = () => new Date(),
} = {}) {
  const normalizedRecipients = normalizeEmailRecipients(recipients);
  const observedAt = now();
  const result = await sendEmail({
    config: applicationConfig.notifications?.email || {},
    payload: {
      eventId: `maintenance-email-test-${observedAt.getTime()}`,
      eventType: "maintenance.email_test",
      recipients: normalizedRecipients,
      subject: "ALPR storage maintenance email test",
      message: "This is a storage maintenance email test from ALPR Database Community. No maintenance alert triggered this message.",
    },
    attachment: null,
  });
  const acceptedCount = Array.isArray(result?.accepted) ? result.accepted.length : 0;
  const rejectedCount = Array.isArray(result?.rejected) ? result.rejected.length : 0;
  if (acceptedCount === 0) {
    throw new Error("SMTP did not accept any maintenance test recipients.");
  }
  return {
    delivered: true,
    acceptedCount,
    rejectedCount,
  };
}
