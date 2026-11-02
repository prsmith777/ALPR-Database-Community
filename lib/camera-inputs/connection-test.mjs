import { randomUUID } from "node:crypto";
import { buildSubscriberOptions } from "./runtime.mjs";

export function testMqttConnection(
  input,
  mqttConnect,
  { timeoutMs = 10000 } = {},
) {
  return new Promise((resolve) => {
    let client;
    let timer;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      client?.end(true, {}, () => {});
      resolve(result);
    };
    timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: "Broker connection or subscription timed out",
        }),
      timeoutMs,
    );
    try {
      if (/[\s/@?#]/.test(input.broker) || input.broker.includes("://"))
        throw new Error("INVALID_HOST");
      const host = input.broker.includes(":")
        ? `[${input.broker.replace(/^\[|\]$/g, "")}]`
        : input.broker;
      client = mqttConnect(
        `${input.use_tls ? "mqtts" : "mqtt"}://${host}:${input.port}`,
        {
          ...buildSubscriberOptions(input),
          clientId: `alpr-axis-test-${randomUUID()}`,
          clean: true,
          reconnectPeriod: 0,
        },
      );
      client.on("error", () =>
        finish({
          ok: false,
          error: "Connection failed. Check broker, credentials and TLS.",
        }),
      );
      client.on("connect", () =>
        client.subscribe(
          input.topic_filter,
          { qos: input.qos },
          (error, granted) => {
            finish(
              !error &&
                granted?.length &&
                granted.every((item) => item.qos <= 1)
                ? {
                    ok: true,
                    message:
                      "Broker connection and topic subscription succeeded",
                  }
                : { ok: false, error: "Broker refused the topic subscription" },
            );
          },
        ),
      );
    } catch {
      finish({
        ok: false,
        error: "Unable to connect to the configured broker",
      });
    }
  });
}
