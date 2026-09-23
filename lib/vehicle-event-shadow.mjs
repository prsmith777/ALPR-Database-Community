import { evaluateShadowPair } from "./vehicle-event-shadow-model.mjs";

export class VehicleEventShadowService {
  constructor({ repository, logger = console } = {}) {
    if (!repository
        || typeof repository.getControl !== "function"
        || typeof repository.listPendingCandidates !== "function") {
      throw new Error("Shadow vehicle event service requires a repository");
    }
    this.repository = repository;
    this.logger = logger;
  }

  async getOverview() {
    return this.repository.getOverview();
  }

  async setEnabled({ enabled, actorUserId }) {
    return this.repository.setEnabled({ enabled, actorUserId });
  }

  async processBatch({ limit } = {}) {
    const control = await this.repository.getControl();
    if (!control.enabled) {
      return {
        status: "idle",
        activation: "disabled",
        processed: 0,
        proposed: 0,
        rejected: 0,
        retired: 0,
      };
    }

    const batchLimit = Number.isSafeInteger(Number(limit))
      ? Number(limit)
      : control.batchSize;
    const retired = await this.repository.retireStaleEvents({ limit: batchLimit });
    const anchors = await this.repository.listPendingCandidates({
      limit: batchLimit,
      settleSeconds: control.settleSeconds,
    });
    let processed = 0;
    let proposed = 0;
    let rejected = 0;
    let superseded = 0;
    let alreadyAssigned = 0;

    for (const anchor of anchors) {
      const companions = await this.repository.findCompanions(anchor);
      const evaluation = evaluateShadowPair(anchor, companions);
      let result;
      if (evaluation.outcome === "proposed") {
        result = await this.repository.createProposedEvent(anchor, evaluation);
        if (result.status === "proposed") proposed += 1;
      } else {
        result = await this.repository.recordRejectedDecision(anchor, evaluation);
        if (result.status === "rejected" && result.created) rejected += 1;
      }
      if (result?.status === "superseded") superseded += 1;
      if (result?.status === "already_assigned" || result?.status === "already_exists") {
        alreadyAssigned += 1;
      }
      processed += 1;
    }

    return {
      status: anchors.length > 0 || retired > 0 ? "working" : "idle",
      activation: "active",
      processed,
      proposed,
      rejected,
      superseded,
      alreadyAssigned,
      retired,
    };
  }
}
