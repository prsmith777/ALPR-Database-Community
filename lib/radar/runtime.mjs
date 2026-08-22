import { RadarRepository } from "./repository.mjs";
import { RadarSubscriber } from "./subscriber.mjs";

const RUNTIME_STATE = Symbol.for("alpr.radar.runtime.state.v1");

function resolveMqttConnect(mqttPackage) {
  const connect = mqttPackage?.connect || mqttPackage?.default?.connect || mqttPackage?.default;
  if (typeof connect !== "function") throw new Error("The MQTT package did not expose connect()");
  return connect;
}

function stateFor(host = globalThis) {
  if (!host[RUNTIME_STATE]) host[RUNTIME_STATE] = { promise: null };
  return host[RUNTIME_STATE];
}

export async function startRadarRuntime({ stateHost = globalThis, logger = console } = {}) {
  const state = stateFor(stateHost);
  if (!state.promise) {
    state.promise = (async () => {
      const [{ getPool }, mqttPackage] = await Promise.all([import("../db.js"), import("mqtt")]);
      const repository = new RadarRepository({ pool: await getPool() });
      const subscriber = new RadarSubscriber({
        repository,
        mqttConnect: resolveMqttConnect(mqttPackage),
        logger,
      });
      const result = await subscriber.start();
      return { repository, subscriber, ...result };
    })().catch((error) => {
      state.promise = null;
      throw error;
    });
  }
  return state.promise;
}

export async function stopRadarRuntime({ stateHost = globalThis } = {}) {
  const state = stateFor(stateHost);
  const runtime = await state.promise?.catch(() => null);
  await runtime?.subscriber?.stop();
  state.promise = null;
}

export const radarRuntimeInternals = Object.freeze({ RUNTIME_STATE, resolveMqttConnect, stateFor });
