import { sendEmailNotification } from "./email-notifications.mjs";
import { sendWebhookNotification } from "./webhook-notifications.mjs";
import { getConfig } from "./settings.js";
import { getStorageMaintenanceConfig } from "./storage-maintenance-repository.mjs";

function unavailableWebhookDestination() {
  const error = new Error("Maintenance webhook delivery is disabled or its destination was cleared");
  error.retryable = false;
  error.code = "MAINTENANCE_WEBHOOK_DESTINATION_UNAVAILABLE";
  return error;
}

function isDeliveryLeaseLost(error) {
  return /maintenance alert delivery lease was lost/i.test(String(error?.message || ""));
}

export class MaintenanceAlertWorker {
  constructor({
    repository,
    sendEmail = sendEmailNotification,
    sendWebhook = sendWebhookNotification,
    loadConfig = getConfig,
    loadMaintenanceConfig = getStorageMaintenanceConfig,
    workerId = `alpr-maintenance-alert-${process.pid}`,
    now = () => new Date(),
    logger = console,
  } = {}) {
    if (!repository) throw new Error("Maintenance alert worker requires a repository");
    this.repository = repository;
    this.sendEmail = sendEmail;
    this.sendWebhook = sendWebhook;
    this.loadConfig = loadConfig;
    this.loadMaintenanceConfig = loadMaintenanceConfig;
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
          : await (async () => {
              const maintenance = await this.loadMaintenanceConfig();
              if (!maintenance.webhookEnabled || !maintenance.webhookUrl) {
                throw unavailableWebhookDestination();
              }
              return this.sendWebhook({
                config: config.notifications?.webhook || {},
                payload: {
                  ...(delivery.payload || {}),
                  url: maintenance.webhookUrl,
                  idempotencyKey: `maintenance-alert-${delivery.id}`,
                },
              });
            })();
        const safeResponse = delivery.channelType === "webhook"
          ? { status: Number(response?.status) || null }
          : response;
        await this.repository.recordSuccess({ deliveryId: delivery.id, workerId: this.workerId, response: safeResponse, now: this.now() });
        results.push("succeeded");
      } catch (error) {
        let failed;
        try {
          failed = await this.repository.recordFailure({ deliveryId: delivery.id, workerId: this.workerId, error, now: this.now() });
        } catch (leaseError) {
          if (!isDeliveryLeaseLost(leaseError)) throw leaseError;
          this.logger?.warn?.("Maintenance alert delivery was retired while in flight", {
            deliveryId: delivery.id,
            channelType: delivery.channelType,
          });
          results.push("retired");
          continue;
        }
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
      retired: results.filter((status) => status === "retired").length,
    };
  }
}

export const maintenanceAlertWorkerInternals = Object.freeze({
  isDeliveryLeaseLost,
  unavailableWebhookDestination,
});
