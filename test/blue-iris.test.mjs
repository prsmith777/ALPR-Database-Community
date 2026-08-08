import assert from "node:assert/strict";
import test from "node:test";

import {
  alertRecordsFromResponse,
  BlueIrisClient,
  BlueIrisError,
  normalizeBlueIrisBaseUrl,
} from "../lib/blue-iris.mjs";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function binaryResponse(buffer, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === "content-length" ? String(buffer.length) : "image/jpeg" },
    async arrayBuffer() { return buffer; },
  };
}

test("Blue Iris server addresses are normalized without accepting embedded credentials or paths", () => {
  assert.equal(normalizeBlueIrisBaseUrl("192.168.0.167:81"), "http://192.168.0.167:81");
  assert.equal(normalizeBlueIrisBaseUrl("https://blueiris.local:443/"), "https://blueiris.local");
  assert.throws(
    () => normalizeBlueIrisBaseUrl("http://admin:secret@192.168.0.167:81"),
    (error) => error instanceof BlueIrisError && error.code === "INVALID_HOST"
  );
  assert.throws(() => normalizeBlueIrisBaseUrl("http://blueiris.local/ui3.htm"), /server address/i);
});

test("Blue Iris login uses the challenge session and never places credentials in the request", async () => {
  const requests = [];
  const client = new BlueIrisClient(
    { host: "192.168.0.167:81", username: "alpr", password: "private-password" },
    {
      fetchImpl: async (_url, options) => {
        const payload = JSON.parse(options.body);
        requests.push(payload);
        if (requests.length === 1) return jsonResponse({ result: "fail", session: "challenge-session" });
        return jsonResponse({
          result: "success",
          session: "active-session",
          data: { systemName: "Smith Home", version: "6.0.9.6" },
        });
      },
    }
  );

  const data = await client.login();
  assert.equal(data.systemName, "Smith Home");
  assert.deepEqual(requests[0], { cmd: "login" });
  assert.equal(requests[1].session, "challenge-session");
  assert.equal(requests[1].response.length, 32);
  assert.equal(JSON.stringify(requests).includes("private-password"), false);
});

test("Blue Iris connection test returns a sanitized camera inventory", async () => {
  const responses = [
    { result: "fail", session: "challenge" },
    { result: "success", data: { systemName: "Smith Home", version: "6.0.9.6" } },
    {
      result: "success",
      data: [
        { optionValue: "Street_LPR_2", optionDisplay: "Street LPR 2", isOnline: true },
        { optionValue: "Entry_LPR_1", optionDisplay: "+Entry LPR 1", isOnline: false },
      ],
    },
  ];
  const client = new BlueIrisClient(
    { host: "blueiris.local:81", username: "alpr", password: "secret" },
    { fetchImpl: async () => jsonResponse(responses.shift()) }
  );

  assert.deepEqual(await client.testConnection(), {
    systemName: "Smith Home",
    version: "6.0.9.6",
    cameraCount: 2,
    cameras: [
      { id: "Street_LPR_2", name: "Street LPR 2", online: true, enabled: true },
      { id: "Entry_LPR_1", name: "Entry LPR 1", online: false, enabled: true },
    ],
  });
});

test("alertlist response variants are accepted", () => {
  const records = [{ date: 1 }, { date: 2 }];
  assert.deepEqual(alertRecordsFromResponse({ data: records }), records);
  assert.deepEqual(alertRecordsFromResponse({ data: { alerts: records } }), records);
  assert.deepEqual(alertRecordsFromResponse({ data: { items: records } }), records);
  assert.deepEqual(alertRecordsFromResponse({ data: { records } }), records);
  assert.deepEqual(alertRecordsFromResponse({ data: {} }), []);
});

test("nearest alert matching uses camera and a bounded timestamp window", async () => {
  const requests = [];
  const target = Date.parse("2026-07-27T22:00:00Z") / 1000;
  const responses = [
    { result: "fail", session: "challenge" },
    { result: "success", session: "active", data: {} },
    {
      result: "success",
      data: [
        { date: target - 40, clip: "@old.bvr", offset: 100 },
        { date: target + 3, clip: "@match.bvr", offset: 2400, msec: 18_000 },
      ],
    },
  ];
  const client = new BlueIrisClient(
    { host: "blueiris.local:81", username: "alpr", password: "secret" },
    {
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse(responses.shift());
      },
    }
  );

  const result = await client.findNearestAlert({
    camera: "Street_LPR_2",
    timestamp: "2026-07-27T22:00:00Z",
    toleranceSeconds: 60,
  });
  assert.equal(result.matched, true);
  assert.equal(result.searchedCount, 2);
  assert.equal(result.alert.clip, "@match.bvr");
  assert.equal(result.alert.deltaSeconds, 3);
  assert.deepEqual(requests[2], {
    cmd: "alertlist",
    camera: "Street_LPR_2",
    view: "alerts",
    startdate: target - 60,
    enddate: target + 60,
    session: "active",
  });
});

test("invalid credentials return a stable error without exposing the password", async () => {
  const client = new BlueIrisClient(
    { host: "blueiris.local:81", username: "alpr", password: "do-not-expose" },
    {
      fetchImpl: async (_url, options) => {
        const payload = JSON.parse(options.body);
        return payload.response
          ? jsonResponse({ result: "fail", data: { reason: "access denied" } })
          : jsonResponse({ result: "fail", session: "challenge" });
      },
    }
  );

  await assert.rejects(
    client.login(),
    (error) => error.code === "LOGIN_FAILED" && !error.message.includes("do-not-expose")
  );
});

test("timeline frame retrieval uses a read-only JPEG request at the requested epoch", async () => {
  const requests = [];
  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const responses = [
    jsonResponse({ result: "fail", session: "challenge" }),
    jsonResponse({ result: "success", session: "active", data: {} }),
    binaryResponse(jpeg),
  ];
  const client = new BlueIrisClient(
    { host: "blueiris.local:81", username: "alpr", password: "secret" },
    { fetchImpl: async (url, options) => {
      requests.push({ url: String(url), method: options.method });
      return responses.shift();
    } }
  );

  const frame = await client.fetchTimelineJpeg({
    camera: "Cam146",
    timestamp: "2026-07-22T17:46:50.000Z",
  });
  const url = new URL(requests[2].url);
  assert.equal(requests[2].method, "GET");
  assert.equal(url.pathname, "/time/Cam146");
  assert.equal(url.searchParams.get("pos"), String(Date.parse("2026-07-22T17:46:50.000Z")));
  assert.equal(url.searchParams.get("jpeg"), "1");
  assert.equal(url.searchParams.get("session"), "active");
  assert.deepEqual(frame.buffer, jpeg);
});

test("missing timeline recording produces a stable terminal error", async () => {
  const responses = [
    jsonResponse({ result: "fail", session: "challenge" }),
    jsonResponse({ result: "success", session: "active", data: {} }),
    binaryResponse(Buffer.alloc(0), 404),
  ];
  const client = new BlueIrisClient(
    { host: "blueiris.local:81", username: "alpr", password: "secret" },
    { fetchImpl: async () => responses.shift() }
  );
  await assert.rejects(
    client.fetchTimelineJpeg({ camera: "Cam146", timestamp: "2026-01-01T00:00:00Z" }),
    (error) => error.code === "RECORDING_UNAVAILABLE"
  );
});
