const LIVE_FEED_STATE = Symbol.for("alpr.live-feed-events");

function state() {
  if (!globalThis[LIVE_FEED_STATE]) {
    globalThis[LIVE_FEED_STATE] = {
      clients: new Map(),
      nextClientId: 1,
      revision: 0,
    };
  }
  return globalThis[LIVE_FEED_STATE];
}

export function addSseClient(send) {
  if (typeof send !== "function") {
    throw new TypeError("SSE client sender must be a function");
  }
  const store = state();
  const clientId = store.nextClientId++;
  store.clients.set(clientId, send);
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
  for (const [clientId, send] of store.clients) {
    try {
      send(payload);
    } catch {
      store.clients.delete(clientId);
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
  delete globalThis[LIVE_FEED_STATE];
}
