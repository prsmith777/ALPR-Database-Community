import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import sharp from "sharp";

import {
  BlueIrisTimelineExportService,
  blueIrisTimelineExportInternals,
} from "../lib/blue-iris-timeline-export.mjs";
import { BlueIrisError } from "../lib/blue-iris.mjs";
import {
  createTimelineExportWorkspace,
  extractTimelineAnalysisFrames,
  extractTimelineFinalFrame,
  probeTimelineExport,
  removeTimelineExportWorkspace,
  sweepTimelineExportWorkspaces,
  TIMELINE_ANALYSIS_FRAME_COUNT,
  runMediaCommand,
} from "../lib/blue-iris-timeline-media.mjs";

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], {
  windowsHide: true,
  stdio: "ignore",
}).status === 0;

test("FFprobe metadata is normalized for timeline export validation", async () => {
  const result = await probeTimelineExport("C:/temporary/timeline.mp4", {
    commandRunner: async (command, args) => {
      assert.equal(command, "ffprobe");
      assert.equal(args.at(-1), path.resolve("C:/temporary/timeline.mp4"));
      return {
        stdout: Buffer.from(JSON.stringify({
          streams: [{ codec_type: "video", codec_name: "h264", width: 3840, height: 2160 }],
          format: { duration: "8.012", start_time: "0.000", size: "123456" },
        })),
        stderr: Buffer.alloc(0),
      };
    },
  });
  assert.deepEqual(result, {
    codec: "h264",
    width: 3840,
    height: 2160,
    durationMs: 8012,
    startTimeMs: 0,
    fileSize: 123456,
  });
});

test("analysis extraction requires 61 local 100ms frames and final extraction uses the same fps slot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpr-bi-media-test-"));
  const framesDirectory = path.join(root, "frames");
  const finalPath = path.join(root, "selected.jpg");
  const commands = [];
  const commandRunner = async (command, args) => {
    commands.push({ command, args });
    if (args.at(-1).endsWith("analysis-%03d.jpg")) {
      await fs.mkdir(framesDirectory, { recursive: true });
      await Promise.all(Array.from({ length: TIMELINE_ANALYSIS_FRAME_COUNT }, (_, index) =>
        fs.writeFile(
          path.join(framesDirectory, `analysis-${String(index).padStart(3, "0")}.jpg`),
          Buffer.from([0xff, 0xd8, index, 0xff, 0xd9])
        )
      ));
    } else if (args.includes(finalPath)) {
      await fs.writeFile(finalPath, Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]));
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  try {
    const frames = await extractTimelineAnalysisFrames({
      inputPath: path.join(root, "timeline.mp4"),
      outputDirectory: framesDirectory,
      trimStartMs: 1_000,
      commandRunner,
    });
    assert.equal(frames.length, 61);
    assert.equal(frames[0].offsetMs, 0);
    assert.equal(frames.at(-1).offsetMs, 6_000);
    await extractTimelineFinalFrame({
      inputPath: path.join(root, "timeline.mp4"),
      outputPath: finalPath,
      trimStartMs: 1_000,
      selectedFrameIndex: 37,
      commandRunner,
    });
    assert.match(commands[0].args.join(" "), /fps=10/);
    assert.match(commands[1].args.join(" "), /setpts=PTS-STARTPTS,trim=start=1\.000:duration=6\.100,setpts=PTS-STARTPTS,fps=10:start_time=0,select=eq\(n\\,37\)/);
    assert.match(commands[1].args.join(" "), /trim=start=1\.000:duration=6\.100/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("real FFmpeg extraction normalizes non-zero source PTS and preserves the selected 10fps slot", {
  skip: !ffmpegAvailable,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpr-bi-real-media-test-"));
  const clipPath = path.join(root, "non-zero-pts.mp4");
  const framesDirectory = path.join(root, "frames");
  const finalPath = path.join(root, "selected.jpg");
  try {
    await runMediaCommand("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=8",
      "-vf", "setpts=PTS+5/TB",
      "-copyts", "-an", "-c:v", "mpeg4", "-q:v", "3", "-y", clipPath,
    ]);
    const frames = await extractTimelineAnalysisFrames({
      inputPath: clipPath,
      outputDirectory: framesDirectory,
      trimStartMs: 1_000,
    });
    assert.equal(frames.length, 61);
    assert.deepEqual([frames[0].offsetMs, frames.at(-1).offsetMs], [0, 6_000]);
    const final = await extractTimelineFinalFrame({
      inputPath: clipPath,
      outputPath: finalPath,
      trimStartMs: 1_000,
      selectedFrameIndex: 37,
    });
    const [analysisRaw, finalRaw] = await Promise.all([
      sharp(frames[37].buffer).resize(64, 36).removeAlpha().raw().toBuffer(),
      sharp(final).resize(64, 36).removeAlpha().raw().toBuffer(),
    ]);
    const meanAbsoluteError = analysisRaw.reduce(
      (sum, value, index) => sum + Math.abs(value - finalRaw[index]),
      0
    ) / analysisRaw.length;
    assert.ok(meanAbsoluteError < 8, `selected slot drifted (MAE ${meanAbsoluteError})`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("temporary export workspaces are bounded to their dedicated root and stale jobs are swept", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpr-bi-sweep-test-"));
  try {
    const workspace = await createTimelineExportWorkspace({ root });
    await fs.utimes(workspace.workspace, new Date(0), new Date(0));
    assert.deepEqual(await sweepTimelineExportWorkspaces({
      root,
      olderThanMs: 1_000,
      now: Date.now(),
    }), { removed: 1 });
    await assert.rejects(
      removeTimelineExportWorkspace({ root, workspace: root }),
      (error) => error.code === "UNSAFE_TEMPORARY_PATH"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function timelineHarness({ width = 3840, height = 2160 } = {}) {
  const events = [];
  let ledger = null;
  const workspace = {
    root: "C:/safe-root",
    workspace: "C:/safe-root/job-1",
    clipPath: "C:/safe-root/job-1/timeline.mp4",
    framesDirectory: "C:/safe-root/job-1/frames",
    finalFramePath: "C:/safe-root/job-1/selected.jpg",
  };
  const repository = {
    async beginTimelineExport(input) {
      events.push(["ledger", input]);
      ledger ||= {
        export_token: "11111111-1111-4111-8111-111111111111",
        export_key: input.exportKey,
        automatic_start_count: 0,
        requested_duration_ms: input.requestedDurationMs,
      };
      return ledger;
    },
    async claimTimelineExportStart(_token, _claimToken, preexistingRemotePaths) {
      events.push(["start_claim", preexistingRemotePaths]);
      if (Number(ledger?.automatic_start_count || 0) >= 1 || ledger?.remote_uri) return null;
      ledger = {
        ...ledger,
        automatic_start_count: 1,
        preexisting_remote_paths: preexistingRemotePaths,
        status: "starting",
      };
      return ledger;
    },
    async getTimelineExport() { return ledger; },
    async recordTimelineExportRemote(_token, remote) {
      events.push(["remote", remote]);
      ledger = {
        ...ledger,
        remote_path: remote.remotePath || ledger?.remote_path || null,
        remote_uri: remote.uri || ledger?.remote_uri || null,
        remote_status: remote.status || ledger?.remote_status || null,
        remote_utc_ms: remote.utc ?? ledger?.remote_utc_ms ?? null,
        remote_duration_ms: remote.durationMs ?? ledger?.remote_duration_ms ?? null,
        progress: remote.progress ?? ledger?.progress ?? null,
        status: remote.complete ? "ready" : "exporting",
      };
      return ledger;
    },
    async heartbeatOverviewRead() { events.push(["heartbeat"]); return { id: 42 }; },
    async markTimelineExportDownloaded(_token, media) {
      events.push(["downloaded", media]);
      ledger = { ...ledger, status: "downloaded" };
      return ledger;
    },
    async markTimelineExportFailed(_token, failure) { events.push(["failed", failure]); },
  };
  const client = {
    async listTimelineExports() {
      events.push(["list"]);
      return [];
    },
    async startTimelineExport(input) {
      events.push(["start", input]);
      return {
        remotePath: "@owned.mp4",
        uri: "@owned.mp4",
        utc: Date.parse("2026-08-09T12:59:59.000Z"),
        durationMs: 8_000,
        camera: "Cam149",
        complete: false,
        failed: false,
        progress: 10,
      };
    },
    async checkTimelineExportDownloadAvailability(uri) {
      events.push(["availability", uri]);
      return { uri, available: true, status: 206 };
    },
    async downloadTimelineExport() { events.push(["download"]); },
  };
  const frames = Array.from({ length: 61 }, (_, index) => ({
    index,
    offsetMs: index * 100,
    buffer: Buffer.from([index]),
  }));
  const media = {
    async createWorkspace() { events.push(["workspace"]); return workspace; },
    async removeWorkspace() { events.push(["cleanup"]); },
    async sweepWorkspaces() { return { removed: 0 }; },
    async probe() {
      events.push(["probe"]);
      return { width, height, durationMs: 8_000, fileSize: 100, codec: "h264" };
    },
    async extractAnalysisFrames(input) {
      events.push(["extract", input]);
      return frames;
    },
    async extractFinalFrame() { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); },
  };
  const logger = {
    info(_message, details) { events.push(["log", details]); },
    warn(_message, details) { events.push(["log", details]); },
  };
  return {
    client,
    repository,
    media,
    logger,
    events,
    setLedger(value) { ledger = value; },
    getLedger() { return ledger; },
  };
}

test("timeline export downloads and validates while Blue Iris owns Clipboard retention", async () => {
  const harness = timelineHarness();
  const sleeps = [];
  const service = new BlueIrisTimelineExportService({
    ...harness,
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  const acquired = await service.acquire({
    read: { id: 42 },
    claimToken: "22222222-2222-4222-8222-222222222222",
    camera: "Cam149",
    sourceCameraName: "Street Overview",
    intendedStartAt: "2026-08-09T13:00:00.000Z",
  });
  assert.equal(acquired.frames.length, 61);
  assert.equal(acquired.remoteRetentionManaged, true);
  assert.equal(acquired.trimStartMs, 1_000);
  const names = harness.events.map(([name]) => name);
  assert.ok(names.indexOf("download") < names.indexOf("probe"));
  assert.ok(names.indexOf("probe") < names.indexOf("downloaded"));
  assert.ok(names.indexOf("downloaded") < names.indexOf("extract"));
  assert.equal(names.includes("delete"), false);
  assert.deepEqual(sleeps, [5_000]);
  assert.equal(harness.events.find(([name]) => name === "start")[1].substream, false);
  assert.equal(harness.events.find(([name]) => name === "start")[1].reencode, false);
  assert.ok(harness.events.some(([name, details]) => (
    name === "log" && details.event === "start_dispatched" && details.readId === 42
  )));
  assert.ok(harness.events.some(([name, details]) => (
    name === "log" && details.event === "download_validated" && details.width === 3840
  )));
  await acquired.cleanup();
});

test("a retry resumes the same stable export and never issues a second cmd:export", async () => {
  const harness = timelineHarness();
  const service = new BlueIrisTimelineExportService({
    ...harness,
    sleepImpl: async () => {},
  });
  const input = {
    read: { id: 42 },
    claimToken: "22222222-2222-4222-8222-222222222222",
    camera: "Cam149",
    sourceCameraName: "Street Overview",
    intendedStartAt: "2026-08-09T13:00:00.000Z",
    pairProfileId: 9,
    profileRevision: 3,
  };
  const first = await service.acquire(input);
  await first.cleanup();
  const second = await service.acquire({
    ...input,
    claimToken: "33333333-3333-4333-8333-333333333333",
  });
  await second.cleanup();

  assert.equal(harness.events.filter(([name]) => name === "start").length, 1);
  assert.equal(harness.events.filter(([name]) => name === "start_claim").length, 1);
  assert.equal(harness.getLedger().automatic_start_count, 1);
});

test("restart reconciliation cannot adopt a matching export that predates the request", async () => {
  const harness = timelineHarness();
  harness.setLedger({
    export_token: "11111111-1111-4111-8111-111111111111",
    automatic_start_count: 1,
    requested_duration_ms: 8_000,
    preexisting_remote_paths: ["@preexisting.mp4"],
    status: "starting",
  });
  harness.client.listTimelineExports = async () => [{
    remotePath: "@preexisting.mp4",
    uri: "@preexisting.mp4",
    utc: Date.parse("2026-08-09T12:59:59.000Z"),
    durationMs: 8_000,
    camera: "Cam149",
  }];
  const service = new BlueIrisTimelineExportService({
    ...harness,
    sleepImpl: async () => {},
  });
  await assert.rejects(
    service.acquire({
      read: { id: 42 },
      claimToken: "22222222-2222-4222-8222-222222222222",
      camera: "Cam149",
      sourceCameraName: "Street Overview",
      intendedStartAt: "2026-08-09T13:00:00.000Z",
      pairProfileId: 9,
      profileRevision: 3,
    }),
    (error) => error.code === "EXPORT_START_UNCERTAIN"
  );
  assert.equal(harness.events.some(([name]) => name === "start"), false);
});

test("legacy duplicate-storm recovery deterministically reuses one equivalent retained export", async () => {
  const harness = timelineHarness();
  harness.setLedger({
    export_token: "11111111-1111-4111-8111-111111111111",
    automatic_start_count: 1,
    requested_duration_ms: 8_000,
    preexisting_remote_paths: [],
    status: "starting",
    legacy_imported: true,
  });
  harness.client.listTimelineExports = async () => ["@duplicate-2.mp4", "@duplicate-1.mp4"].map((remotePath) => ({
    remotePath,
    uri: remotePath,
    utc: Date.parse("2026-08-09T12:59:59.000Z"),
    durationMs: 8_000,
    camera: "Cam149",
    complete: true,
    progress: 100,
  }));
  const service = new BlueIrisTimelineExportService({
    ...harness,
    sleepImpl: async () => {},
  });
  const acquired = await service.acquire({
    read: { id: 42 },
    claimToken: "22222222-2222-4222-8222-222222222222",
    camera: "Cam149",
    sourceCameraName: "Street Overview",
    intendedStartAt: "2026-08-09T13:00:00.000Z",
    pairProfileId: 9,
    profileRevision: 3,
  });
  assert.equal(harness.getLedger().remote_uri, "@duplicate-1.mp4");
  assert.equal(harness.events.some(([name]) => name === "start"), false);
  assert.ok(harness.events.some(([name, details]) => (
    name === "log" && details.event === "legacy_duplicate_export_adopted"
      && details.equivalentMatches === 2
  )));
  await acquired.cleanup();
});

test("stable export identity changes only when its semantic job changes", () => {
  const base = {
    readId: 42,
    camera: "Cam149",
    requestedStartMs: Date.parse("2026-08-09T12:59:59.000Z"),
    requestedDurationMs: 8_000,
    exportProfile: 0,
    pairProfileId: 9,
    profileRevision: 3,
  };
  const first = blueIrisTimelineExportInternals.stableTimelineExportKey(base);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(
    first,
    blueIrisTimelineExportInternals.stableTimelineExportKey({ ...base, camera: " cam149 " })
  );
  assert.notEqual(
    first,
    blueIrisTimelineExportInternals.stableTimelineExportKey({ ...base, profileRevision: 4 })
  );
});

test("a Blue Iris command rejection is reconciled when the accepted export appears later", async () => {
  const harness = timelineHarness();
  let listCount = 0;
  harness.client.listTimelineExports = async () => {
    listCount += 1;
    if (listCount < 3) return [];
    return [{
      remotePath: "@accepted-after-rejection.mp4",
      uri: "@accepted-after-rejection.mp4",
      complete: true,
      failed: false,
      progress: 100,
      utc: Date.parse("2026-08-09T12:59:59.000Z"),
      durationMs: 8_000,
      camera: "Cam149",
    }];
  };
  let startCount = 0;
  harness.client.startTimelineExport = async () => {
    startCount += 1;
    throw new BlueIrisError("COMMAND_FAILED", "Blue Iris rejected export");
  };
  const sleeps = [];
  const service = new BlueIrisTimelineExportService({
    ...harness,
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  const acquired = await service.acquire({
    read: { id: 42 },
    claimToken: "22222222-2222-4222-8222-222222222222",
    camera: "Cam149",
    sourceCameraName: "Street Overview",
    intendedStartAt: "2026-08-09T13:00:00.000Z",
    pairProfileId: 9,
    profileRevision: 3,
  });
  assert.equal(startCount, 1);
  assert.ok(sleeps.includes(5_000));
  assert.equal(harness.getLedger().remote_uri, "@accepted-after-rejection.mp4");
  await acquired.cleanup();
});

test("a queued owned path waits for its URI and exact timeline metadata", async () => {
  const harness = timelineHarness();
  let listCount = 0;
  harness.client.listTimelineExports = async () => {
    listCount += 1;
    if (listCount === 1) return [];
    if (listCount === 2) return [{
      remotePath: "@queued-owned.mp4",
      utc: Date.parse("2026-08-09T12:59:59.000Z"),
      durationMs: 8_000,
      camera: "Cam149",
    }];
    return [{
      remotePath: "@queued-owned.mp4",
      uri: "@queued-owned.mp4",
      utc: Date.parse("2026-08-09T12:59:59.000Z"),
      durationMs: 8_000,
      camera: "Cam149",
      complete: true,
      progress: 100,
    }];
  };
  harness.client.startTimelineExport = async (input) => {
    harness.events.push(["start", input]);
    return { remotePath: "@queued-owned.mp4", status: "queued" };
  };
  const sleeps = [];
  const service = new BlueIrisTimelineExportService({
    ...harness,
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  const acquired = await service.acquire({
    read: { id: 42 },
    claimToken: "22222222-2222-4222-8222-222222222222",
    camera: "Cam149",
    sourceCameraName: "Street Overview",
    intendedStartAt: "2026-08-09T13:00:00.000Z",
    pairProfileId: 9,
    profileRevision: 3,
  });
  assert.equal(harness.getLedger().remote_uri, "@queued-owned.mp4");
  assert.equal(harness.events.filter(([name]) => name === "start").length, 1);
  assert.ok(sleeps.filter((value) => value === 5_000).length >= 2);
  await acquired.cleanup();
});

test("an exact owned path with timeline metadata is directly downloadable without list visibility", async () => {
  const harness = timelineHarness();
  let listCount = 0;
  harness.client.listTimelineExports = async () => {
    listCount += 1;
    return [];
  };
  harness.client.startTimelineExport = async (input) => {
    harness.events.push(["start", input]);
    return {
      remotePath: "@direct-owned.mp4",
      utc: Date.parse("2026-08-09T12:59:59.000Z"),
      durationMs: 8_000,
      camera: "Cam149",
      status: "queued",
    };
  };
  const service = new BlueIrisTimelineExportService({ ...harness, sleepImpl: async () => {} });
  const acquired = await service.acquire({
    read: { id: 42 },
    claimToken: "22222222-2222-4222-8222-222222222222",
    camera: "Cam149",
    sourceCameraName: "Street Overview",
    intendedStartAt: "2026-08-09T13:00:00.000Z",
    pairProfileId: 9,
    profileRevision: 3,
  });
  assert.equal(harness.getLedger().remote_uri, "@direct-owned.mp4");
  assert.equal(harness.events.find(([name]) => name === "availability")[1], "@direct-owned.mp4");
  assert.equal(listCount, 1);
  assert.equal(harness.events.filter(([name]) => name === "start").length, 1);
  await acquired.cleanup();
});

test("a resumed path-only ledger resolves the same path without another export", async () => {
  const harness = timelineHarness();
  harness.setLedger({
    export_token: "11111111-1111-4111-8111-111111111111",
    automatic_start_count: 1,
    requested_duration_ms: 8_000,
    remote_path: "@resumed-owned.mp4",
    remote_uri: null,
    status: "exporting",
  });
  harness.client.listTimelineExports = async () => [{
    remotePath: "@resumed-owned.mp4",
    uri: "@resumed-owned.mp4",
    utc: Date.parse("2026-08-09T12:59:59.000Z"),
    durationMs: 8_000,
    camera: "Cam149",
    complete: true,
    progress: 100,
  }];
  const service = new BlueIrisTimelineExportService({ ...harness, sleepImpl: async () => {} });
  const acquired = await service.acquire({
    read: { id: 42 },
    claimToken: "22222222-2222-4222-8222-222222222222",
    camera: "Cam149",
    sourceCameraName: "Street Overview",
    intendedStartAt: "2026-08-09T13:00:00.000Z",
    pairProfileId: 9,
    profileRevision: 3,
  });
  assert.equal(harness.events.some(([name]) => name === "start"), false);
  assert.equal(harness.getLedger().remote_uri, "@resumed-owned.mp4");
  await acquired.cleanup();
});

test("legacy matches with different exact UTC identities remain quarantined", async () => {
  const harness = timelineHarness();
  harness.setLedger({
    export_token: "11111111-1111-4111-8111-111111111111",
    automatic_start_count: 1,
    requested_duration_ms: 8_000,
    preexisting_remote_paths: [],
    status: "starting",
    legacy_imported: true,
  });
  harness.client.listTimelineExports = async () => [0, 500].map((delta, index) => ({
    remotePath: `@different-${index}.mp4`,
    uri: `@different-${index}.mp4`,
    utc: Date.parse("2026-08-09T12:59:59.000Z") + delta,
    durationMs: 8_000,
    camera: "Cam149",
    complete: true,
    progress: 100,
  }));
  const service = new BlueIrisTimelineExportService({ ...harness, sleepImpl: async () => {} });
  await assert.rejects(
    service.acquire({
      read: { id: 42 },
      claimToken: "22222222-2222-4222-8222-222222222222",
      camera: "Cam149",
      sourceCameraName: "Street Overview",
      intendedStartAt: "2026-08-09T13:00:00.000Z",
      pairProfileId: 9,
      profileRevision: 3,
    }),
    (error) => error.code === "EXPORT_START_UNCERTAIN"
  );
  assert.equal(harness.events.some(([name]) => name === "start"), false);
});

test("the pre-dispatch snapshot retains a relevant old export beyond two thousand list rows", async () => {
  const harness = timelineHarness();
  const relevant = {
    remotePath: "@relevant-old.mp4",
    uri: "@relevant-old.mp4",
    utc: Date.parse("2026-08-09T12:59:59.000Z"),
    durationMs: 8_000,
    camera: "Cam149",
  };
  let listCount = 0;
  harness.client.listTimelineExports = async () => {
    listCount += 1;
    if (listCount === 1) {
      return [
        ...Array.from({ length: 2_100 }, (_, index) => ({
          remotePath: `@irrelevant-${index}.mp4`,
          uri: `@irrelevant-${index}.mp4`,
          utc: Date.parse("2026-08-09T10:00:00.000Z") + index,
          durationMs: 8_000,
          camera: "Cam149",
        })),
        relevant,
      ];
    }
    return [relevant];
  };
  harness.client.startTimelineExport = async () => {
    harness.events.push(["start"]);
    throw new BlueIrisError("COMMAND_FAILED", "Blue Iris rejected export");
  };
  const service = new BlueIrisTimelineExportService({ ...harness, sleepImpl: async () => {} });
  await assert.rejects(
    service.acquire({
      read: { id: 42 },
      claimToken: "22222222-2222-4222-8222-222222222222",
      camera: "Cam149",
      sourceCameraName: "Street Overview",
      intendedStartAt: "2026-08-09T13:00:00.000Z",
      pairProfileId: 9,
      profileRevision: 3,
    }),
    (error) => error.code === "EXPORT_START_UNCERTAIN"
  );
  const snapshot = harness.events.find(([name]) => name === "start_claim")[1];
  assert.deepEqual(snapshot, ["@relevant-old.mp4"]);
  assert.equal(harness.events.filter(([name]) => name === "start").length, 1);
});

test("timeline export fails closed on low resolution without requesting remote deletion", async () => {
  const harness = timelineHarness({ width: 1280, height: 720 });
  const service = new BlueIrisTimelineExportService({
    ...harness,
    sleepImpl: async () => {},
  });
  await assert.rejects(
    service.acquire({
      read: { id: 42 },
      claimToken: "22222222-2222-4222-8222-222222222222",
      camera: "Cam149",
      sourceCameraName: "Street Overview",
      intendedStartAt: "2026-08-09T13:00:00.000Z",
    }),
    (error) => error.code === "EXPORT_RESOLUTION_TOO_LOW"
  );
  const names = harness.events.map(([name]) => name);
  assert.equal(names.includes("delete"), false);
  assert.ok(names.includes("cleanup"));
  assert.equal(names.includes("extract"), false);
});

test("timeline export fails closed when Blue Iris omits exact UTC alignment metadata", async () => {
  const harness = timelineHarness();
  harness.client.startTimelineExport = async (input) => {
    harness.events.push(["start", input]);
    return {
      remotePath: "@owned.mp4",
      complete: false,
      failed: false,
      progress: 10,
      uri: "@owned.mp4",
      durationMs: 8_000,
      camera: "Cam149",
    };
  };
  const service = new BlueIrisTimelineExportService({
    ...harness,
    sleepImpl: async () => {},
  });
  await assert.rejects(
    service.acquire({
      read: { id: 42 },
      claimToken: "22222222-2222-4222-8222-222222222222",
      camera: "Cam149",
      sourceCameraName: "Street Overview",
      intendedStartAt: "2026-08-09T13:00:00.000Z",
    }),
    (error) => error.code === "EXPORT_TIMELINE_UNVERIFIED"
  );
  assert.equal(harness.events.some(([name]) => name === "delete"), false);
});

test("one exact export-list match is adopted after an uncertain start response", async () => {
  const harness = timelineHarness();
  let listCount = 0;
  harness.client.listTimelineExports = async () => {
    listCount += 1;
    if (listCount <= 2) return [];
    return [{
      remotePath: "@adopted.mp4",
      complete: true,
      failed: false,
      progress: 100,
      uri: "@adopted.mp4",
      utc: Date.parse("2026-08-09T12:59:59.000Z"),
      durationMs: 8_000,
      fileSize: 100,
    }];
  };
  harness.client.startTimelineExport = async () => {
    throw new BlueIrisError("TIMEOUT", "response lost");
  };
  const service = new BlueIrisTimelineExportService({
    ...harness,
    sleepImpl: async () => {},
  });
  const acquired = await service.acquire({
    read: { id: 42 },
    claimToken: "22222222-2222-4222-8222-222222222222",
    camera: "Cam149",
    sourceCameraName: "Street Overview",
    intendedStartAt: "2026-08-09T13:00:00.000Z",
  });
  assert.equal(acquired.frames.length, 61);
  assert.equal(listCount, 3);
  assert.ok(harness.events.some(([name]) => name === "download"));
  await acquired.cleanup();
});

test("an unavailable exact export URI waits five seconds before checking again", async () => {
  const harness = timelineHarness();
  harness.client.startTimelineExport = async (input) => {
    harness.events.push(["start", input]);
    return {
      remotePath: "@disappeared.mp4",
      complete: false,
      failed: false,
      progress: 25,
      uri: "@disappeared.mp4",
      utc: Date.parse("2026-08-09T12:59:59.000Z"),
      durationMs: 8_000,
      camera: "Cam149",
      fileSize: 100,
    };
  };
  let availabilityChecks = 0;
  harness.client.checkTimelineExportDownloadAvailability = async (uri) => {
    availabilityChecks += 1;
    harness.events.push(["availability", uri, availabilityChecks]);
    return { uri, available: availabilityChecks >= 2, status: availabilityChecks >= 2 ? 206 : 404 };
  };
  const sleeps = [];
  const service = new BlueIrisTimelineExportService({
    ...harness,
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  const acquired = await service.acquire({
    read: { id: 42 },
    claimToken: "22222222-2222-4222-8222-222222222222",
    camera: "Cam149",
    sourceCameraName: "Street Overview",
    intendedStartAt: "2026-08-09T13:00:00.000Z",
  });
  assert.equal(availabilityChecks, 2);
  assert.deepEqual(sleeps, [5_000, 5_000]);
  assert.ok(harness.events.some(([name]) => name === "download"));
  await acquired.cleanup();
});

test("ambiguous uncertain starts are not blindly resubmitted or deleted", async () => {
  const harness = timelineHarness();
  let listCount = 0;
  let startCount = 0;
  harness.client.listTimelineExports = async () => {
    listCount += 1;
    if (listCount === 1) return [];
    return ["@first.mp4", "@second.mp4"].map((remotePath) => ({
      remotePath,
      complete: false,
      failed: false,
      utc: Date.parse("2026-08-09T12:59:59.000Z"),
      durationMs: 8_000,
      camera: "Cam149",
    }));
  };
  harness.client.startTimelineExport = async () => {
    startCount += 1;
    throw new BlueIrisError("TIMEOUT", "response lost");
  };
  const service = new BlueIrisTimelineExportService({
    ...harness,
    sleepImpl: async () => {},
  });
  await assert.rejects(
    service.acquire({
      read: { id: 42 },
      claimToken: "22222222-2222-4222-8222-222222222222",
      camera: "Cam149",
      sourceCameraName: "Street Overview",
      intendedStartAt: "2026-08-09T13:00:00.000Z",
    }),
    (error) => error.code === "EXPORT_START_UNCERTAIN" && error.details.matchingJobs === 2
  );
  assert.equal(startCount, 1);
  assert.equal(harness.events.some(([name]) => name === "delete"), false);
});

test("remote export reconciliation is inert because Blue Iris owns Clipboard retention", async () => {
  const harness = timelineHarness();
  harness.repository.claimTimelineExportsNeedingCleanup = async () => {
    assert.fail("retention-managed exports must not be claimed for deletion");
  };
  harness.client.deleteTimelineExport = async () => {
    assert.fail("ALPR must not request Blue Iris Clipboard deletion");
  };
  const service = new BlueIrisTimelineExportService({
    ...harness,
    sleepImpl: async () => {},
  });
  assert.deepEqual(await service.reconcileRemoteExports({ limit: 50 }), {
    examined: 0,
    deleted: 0,
    failed: 0,
    retentionManagedBy: "blue_iris",
  });
});
