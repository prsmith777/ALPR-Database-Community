const LIVE_FEED_STATE = Symbol.for("alpr.live-feed-events");

function state() {
  if (!globalThis[LIVE_FEED_STATE]) {
    const store = {
      clients: new Map(),
      nextClientId: 1,
      revision: 0,
      stopping: false,
    };
    // Next.js waits for open HTTP responses before finishing its shutdown.
    // Finish live streams on the same signal so that wait can complete.
    store.shutdown = () => {
      store.stopping = true;
      const clients = [...store.clients.values()];
      store.clients.clear();
      for (const client of clients) {
        try { client.close?.(); } catch { /* Continue closing other responses. */ }
      }
    };
    process.once("SIGINT", store.shutdown);
    process.once("SIGTERM", store.shutdown);
    globalThis[LIVE_FEED_STATE] = store;
  }
  return globalThis[LIVE_FEED_STATE];
}

export function addSseClient(send, close = null) {
  if (typeof send !== "function" || (close !== null && typeof close !== "function")) {
    throw new TypeError("SSE client callbacks must be functions");
  }
  const store = state();
  if (store.stopping) {
    close?.();
    return null;
  }
  const clientId = store.nextClientId++;
  store.clients.set(clientId, { send, close });
  return clientId;
}

export function removeSseClient(clientId) {
  state().clients.delete(clientId);
}

export function formatSseEvent(event, data, { id = null } = {}) {
  const lines = [];
  if (id !== null && id !== undefined) lines.push(`id: ${id}`);
  if (event) lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join("\n")}\n\n`;
}

export function sendSseEventToAll(event, data) {
  const store = state();
  const revision = ++store.revision;
  const payload = formatSseEvent(event, { ...data, revision }, { id: revision });
  for (const [clientId, client] of store.clients) {
    try {
      client.send(payload);
    } catch {
      store.clients.delete(clientId);
      try { client.close?.(); } catch { /* A failed client cannot block others. */ }
    }
  }
  return revision;
}

export function publishPlateReadChanges(readIds, reason = "changed") {
  const normalizedReadIds = [...new Set((readIds || [])
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (normalizedReadIds.length === 0) return null;
  return sendSseEventToAll("plate-reads-changed", {
    readIds: normalizedReadIds,
    reason,
  });
}

export function liveFeedEventStateForTest() {
  const store = state();
  return { clients: store.clients.size, revision: store.revision };
}

export function resetLiveFeedEventStateForTest() {
  const store = globalThis[LIVE_FEED_STATE];
  if (store) {
    store.shutdown();
    process.removeListener("SIGINT", store.shutdown);
    process.removeListener("SIGTERM", store.shutdown);
  }
  delete globalThis[LIVE_FEED_STATE];
}
