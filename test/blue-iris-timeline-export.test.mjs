import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import sharp from "sharp";

import { BlueIrisTimelineExportService } from "../lib/blue-iris-timeline-export.mjs";
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
      return { export_token: "11111111-1111-4111-8111-111111111111" };
    },
    async recordTimelineExportRemote(_token, remote) { events.push(["remote", remote]); },
    async heartbeatOverviewRead() { events.push(["heartbeat"]); return { id: 42 }; },
    async markTimelineExportDownloaded(_token, media) { events.push(["downloaded", media]); },
    async markTimelineExportDeleted() { events.push(["ledger-deleted"]); },
    async markTimelineExportFailed(_token, failure) { events.push(["failed", failure]); },
  };
  const client = {
    async listTimelineExports() {
      events.push(["list"]);
      return [];
    },
    async startTimelineExport(input) {
      events.push(["start", input]);
      return { remotePath: "@owned.mp4", complete: false, failed: false, progress: 10 };
    },
    async getTimelineExport() {
      events.push(["poll"]);
      return {
        remotePath: "@owned.mp4",
        complete: true,
        failed: false,
        progress: 100,
        uri: "@owned.mp4",
        utc: Date.parse("2026-08-09T12:59:59.000Z"),
        durationMs: 8_000,
        camera: "Cam149",
        fileSize: 100,
      };
    },
    async downloadTimelineExport() { events.push(["download"]); },
    async deleteTimelineExport(remotePath, options) { events.push(["delete", remotePath, options]); },
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
  return { client, repository, media, events };
}

test("timeline export downloads and validates before immediate delete:true cleanup", async () => {
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
  assert.equal(acquired.deletedRemotely, true);
  assert.equal(acquired.trimStartMs, 1_000);
  const names = harness.events.map(([name]) => name);
  assert.ok(names.indexOf("download") < names.indexOf("probe"));
  assert.ok(names.indexOf("probe") < names.indexOf("delete"));
  assert.ok(names.indexOf("delete") < names.indexOf("extract"));
  assert.deepEqual(sleeps, [5_000]);
  assert.deepEqual(harness.events.find(([name]) => name === "delete"), [
    "delete",
    "@owned.mp4",
    { uri: "@owned.mp4" },
  ]);
  assert.equal(harness.events.find(([name]) => name === "start")[1].substream, false);
  await acquired.cleanup();
});

test("timeline export fails closed on low resolution but still deletes the owned remote export", async () => {
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
  assert.ok(names.includes("delete"));
  assert.ok(names.includes("cleanup"));
  assert.equal(names.includes("extract"), false);
});

test("timeline export fails closed when Blue Iris omits exact UTC alignment metadata", async () => {
  const harness = timelineHarness();
  harness.client.getTimelineExport = async () => ({
    remotePath: "@owned.mp4",
    complete: true,
    failed: false,
    progress: 100,
    uri: "@owned.mp4",
    durationMs: 8_000,
    camera: "Cam149",
  });
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
  assert.ok(harness.events.some(([name]) => name === "delete"));
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

test("an unavailable exact export status fails closed without attempting a download", async () => {
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
  harness.client.getTimelineExport = async () => {
    harness.events.push(["poll-disappeared"]);
    throw new BlueIrisError("EXPORT_UNAVAILABLE", "completed job left the active queue");
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
    (error) => error.code === "EXPORT_UNAVAILABLE"
  );
  assert.ok(harness.events.some(([name]) => name === "poll-disappeared"));
  assert.equal(harness.events.some(([name]) => name === "download"), false);
});

test("ambiguous uncertain starts are not blindly resubmitted or deleted", async () => {
  const harness = timelineHarness();
  let listCount = 0;
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
  assert.equal(harness.events.some(([name]) => name === "delete"), false);
});

test("a failed immediate delete is deferred without discarding a valid local export", async () => {
  const harness = timelineHarness();
  harness.client.deleteTimelineExport = async () => {
    harness.events.push(["delete-failed"]);
    throw new BlueIrisError("CONNECTION_FAILED", "temporary cleanup failure");
  };
  const service = new BlueIrisTimelineExportService({
    ...harness,
    sleepImpl: async () => {},
    logger: { warn() {} },
  });
  const acquired = await service.acquire({
    read: { id: 42 },
    claimToken: "22222222-2222-4222-8222-222222222222",
    camera: "Cam149",
    sourceCameraName: "Street Overview",
    intendedStartAt: "2026-08-09T13:00:00.000Z",
  });
  assert.equal(acquired.frames.length, 61);
  assert.equal(acquired.deletedRemotely, false);
  const pending = harness.events.find(([name, failure]) =>
    name === "failed" && failure?.errorCode === "EXPORT_DELETE_FAILED");
  assert.ok(pending);
  assert.equal(pending[1].deletePending, true);
  await acquired.cleanup();
});
