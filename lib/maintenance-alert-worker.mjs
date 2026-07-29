import { sendEmailNotification } from "./email-notifications.mjs";
import { sendWebhookNotification } from "./webhook-notifications.mjs";
import { getConfig } from "./settings.js";

export class MaintenanceAlertWorker {
  constructor({
    repository,
    sendEmail = sendEmailNotification,
    sendWebhook = sendWebhookNotification,
    loadConfig = getConfig,
    workerId = `alpr-maintenance-alert-${process.pid}`,
    now = () => new Date(),
    logger = console,
  } = {}) {
    if (!repository) throw new Error("Maintenance alert worker requires a repository");
    this.repository = repository;
    this.sendEmail = sendEmail;
    this.sendWebhook = sendWebhook;
    this.loadConfig = loadConfig;
    this.workerId = workerId;
    this.now = now;
    this.logger = logger;
  }

  async runBatch() {
    const now = this.now();
    await this.repository.releaseExpiredLeases({ now });
    const deliveries = await this.repository.claimDue({ workerId: this.workerId, now, limit: 10 });
    const config = deliveries.length ? await this.loadConfig() : {};
    const results = [];
    for (const delivery of deliveries) {
      try {
        const response = delivery.channelType === "email"
          ? await this.sendEmail({ config: config.notifications?.email || {}, payload: delivery.payload || {}, attachment: null })
          : await this.sendWebhook({
              config: config.notifications?.webhook || {},
              payload: { ...(delivery.payload || {}), idempotencyKey: `maintenance-alert-${delivery.id}` },
            });
        await this.repository.recordSuccess({ deliveryId: delivery.id, workerId: this.workerId, response, now: this.now() });
        results.push("succeeded");
      } catch (error) {
        const failed = await this.repository.recordFailure({ deliveryId: delivery.id, workerId: this.workerId, error, now: this.now() });
        this.logger?.[failed.status === "dead" ? "error" : "warn"]?.("Maintenance alert delivery failed", {
          deliveryId: delivery.id,
          channelType: delivery.channelType,
          status: failed.status,
        });
        results.push(failed.status);
      }
    }
    return {
      claimed: deliveries.length,
      succeeded: results.filter((status) => status === "succeeded").length,
      retry: results.filter((status) => status === "retry").length,
      dead: results.filter((status) => status === "dead").length,
    };
  }
}
