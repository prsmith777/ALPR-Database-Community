import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  alertRecordsFromResponse,
  BlueIrisClient,
  BlueIrisError,
  normalizeBlueIrisBaseUrl,
  timelineExportFromResponse,
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
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(buffer);
        controller.close();
      },
    }),
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

test("timeline export lifecycle uses the documented start, poll, download, and delete commands", async () => {
  const requests = [];
  const mp4 = Buffer.from("synthetic-mp4-payload");
  const responses = [
    jsonResponse({ result: "fail", session: "challenge" }),
    jsonResponse({ result: "success", session: "active", data: {} }),
    jsonResponse({
      result: "success",
      data: { path: "@ALPR_42.mp4", status: "exporting", progress: 5 },
    }),
    jsonResponse({
      result: "success",
      data: {
        path: "@ALPR_42.mp4",
        status: "completed",
        progress: 100,
        uri: "@ALPR_42.mp4",
        filesize: mp4.length,
        utc: 1_786_300_000_000,
        msec: 8_000,
        camera: "Cam149",
      },
    }),
    binaryResponse(mp4),
    jsonResponse({ result: "success", data: { path: "@ALPR_42.mp4" } }),
    jsonResponse({ result: "fail", data: { reason: "export not found" } }),
    binaryResponse(Buffer.alloc(0), 404),
  ];
  const client = new BlueIrisClient(
    { host: "blueiris.local:81", username: "alpr", password: "secret" },
    { fetchImpl: async (url, options) => {
      requests.push({
        url: String(url),
        method: options.method,
        body: options.body ? JSON.parse(options.body) : null,
      });
      return responses.shift();
    } }
  );
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpr-bi-client-test-"));
  const destinationPath = path.join(directory, "timeline.mp4");
  try {
    const started = await client.startTimelineExport({
      camera: "Cam149",
      start: "2026-08-09T13:00:00.000Z",
      durationMs: 8_000,
      profile: 0,
    });
    assert.equal(started.remotePath, "@ALPR_42.mp4");
    assert.equal(started.complete, false);
    const completed = await client.getTimelineExport(started.remotePath);
    assert.equal(completed.complete, true);
    assert.equal(completed.uri, "@ALPR_42.mp4");
    assert.equal(completed.utc, 1_786_300_000_000);
    assert.equal(completed.durationMs, 8_000);
    const downloaded = await client.downloadTimelineExport({
      uri: completed.uri,
      destinationPath,
    });
    assert.equal(downloaded.bytes, mp4.length);
    assert.deepEqual(await fs.readFile(destinationPath), mp4);
    assert.deepEqual(await client.deleteTimelineExport(started.remotePath, {
      uri: completed.uri,
    }), {
      remotePath: "@ALPR_42.mp4",
      deleted: true,
      alreadyMissing: false,
      verification: {
        remotePath: "@ALPR_42.mp4",
        uri: "@ALPR_42.mp4",
        deleted: true,
        recordAvailable: false,
        downloadAvailable: false,
        downloadStatus: 404,
      },
    });
    assert.deepEqual(requests[2].body, {
      cmd: "export",
      path: "Cam149",
      startms: Date.parse("2026-08-09T13:00:00.000Z"),
      msec: 8_000,
      format: 1,
      profile: 0,
      reencode: true,
      substream: false,
      audio: false,
      overlay: false,
      session: "active",
    });
    assert.deepEqual(requests[3].body, {
      cmd: "export",
      path: "@ALPR_42.mp4",
      session: "active",
    });
    assert.match(requests[4].url, /\/clips\/%40ALPR_42\.mp4\?dl=1&session=active$/);
    assert.deepEqual(requests[5].body, {
      cmd: "export",
      path: "@ALPR_42.mp4",
      delete: true,
      session: "active",
    });
    assert.deepEqual(requests[6].body, {
      cmd: "export",
      path: "@ALPR_42.mp4",
      session: "active",
    });
    assert.match(requests[7].url, /\/clips\/%40ALPR_42\.mp4\?dl=1&session=active$/);
    assert.equal(requests[7].method, "GET");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("timeline export deletion is not reported successful while the exported file remains downloadable", async () => {
  const requests = [];
  const responses = [
    jsonResponse({ result: "fail", session: "challenge" }),
    jsonResponse({ result: "success", session: "active", data: {} }),
    jsonResponse({ result: "success", data: { path: "@still-there.mp4" } }),
    jsonResponse({ result: "fail", data: { reason: "export not found" } }),
    binaryResponse(Buffer.from("still present")),
  ];
  const client = new BlueIrisClient(
    { host: "blueiris.local:81", username: "alpr", password: "secret" },
    { fetchImpl: async (url, options) => {
      requests.push({
        url: String(url),
        method: options.method,
        headers: options.headers || null,
        body: options.body ? JSON.parse(options.body) : null,
      });
      return responses.shift();
    } }
  );

  await assert.rejects(
    client.deleteTimelineExport("@still-there.mp4", { uri: "@still-there.mp4" }),
    (error) => error.code === "EXPORT_DELETE_UNVERIFIED"
      && error.details?.recordAvailable === false
      && error.details?.downloadAvailable === true
  );
  assert.equal(requests[4].headers.range, "bytes=0-0");
});

test("timeline export creation can explicitly disable re-encoding", async () => {
  const requests = [];
  const responses = [
    jsonResponse({ result: "fail", session: "challenge" }),
    jsonResponse({ result: "success", session: "active", data: {} }),
    jsonResponse({
      result: "success",
      data: { path: "Clipboard\\ALPR_DIAGNOSTIC.mp4", status: "queued" },
    }),
  ];
  const client = new BlueIrisClient(
    { host: "blueiris.local:81", username: "alpr", password: "secret" },
    { fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return responses.shift();
    } }
  );

  await client.startTimelineExport({
    camera: "Cam149",
    start: "2026-08-09T13:00:00.000Z",
    durationMs: 8_000,
    profile: 0,
    reencode: false,
    substream: false,
  });

  assert.equal(requests[2].reencode, false);
  assert.equal(requests[2].format, 1);
  assert.equal(requests[2].substream, false);
});

test("timeline export response normalization rejects unsafe paths and recognizes completed exports", () => {
  assert.deepEqual(
    timelineExportFromResponse({
      result: "success",
      data: { path: "@safe.mp4", progress: 100, uri: "@safe.mp4", filesize: 123 },
    }),
    {
      remotePath: "@safe.mp4",
      progress: 100,
      status: "",
      error: null,
      fileSize: 123,
      uri: "@safe.mp4",
      utc: null,
      durationMs: null,
      camera: null,
      failed: false,
      complete: true,
    }
  );
  assert.throws(
    () => timelineExportFromResponse({ data: { path: "unsafe\npath", progress: 1 } }),
    (error) => error.code === "INVALID_EXPORT_PATH"
  );
  assert.equal(
    timelineExportFromResponse({
      result: "success",
      data: { path: "@reserved.mp4", uri: "@reserved.mp4" },
    }).complete,
    false,
    "a reserved download URI without explicit completion must remain in progress"
  );
});
