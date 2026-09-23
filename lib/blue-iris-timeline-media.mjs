import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BlueIrisError } from "./blue-iris.mjs";

export const TIMELINE_EXPORT_PADDING_MS = 1_000;
export const TIMELINE_EXPORT_DURATION_MS = 8_000;
export const TIMELINE_ANALYSIS_DURATION_MS = 6_000;
export const TIMELINE_ANALYSIS_INTERVAL_MS = 100;
export const TIMELINE_ANALYSIS_FRAME_COUNT = 61;
export const TIMELINE_ANALYSIS_WIDTH = 1_280;

const COMMAND_OUTPUT_LIMIT = 2 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 90_000;
const DEFAULT_TEMPORARY_ROOT = path.join(os.tmpdir(), "alpr-blue-iris-exports");

function boundedOutputAppend(current, chunk) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  if (next.length > COMMAND_OUTPUT_LIMIT) {
    throw new BlueIrisError("MEDIA_TOOL_OUTPUT_TOO_LARGE", "A media tool returned too much output.");
  }
  return next;
}

export async function runMediaCommand(command, args, {
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new BlueIrisError(
        "MEDIA_TOOL_TIMEOUT",
        `${command} did not finish before the processing deadline.`
      )));
    }, Math.max(1_000, Number(timeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS));
    child.stdout?.on("data", (chunk) => {
      try {
        stdout = boundedOutputAppend(stdout, chunk);
      } catch (error) {
        child.kill("SIGKILL");
        finish(() => reject(error));
      }
    });
    child.stderr?.on("data", (chunk) => {
      try {
        stderr = boundedOutputAppend(stderr, chunk);
      } catch (error) {
        child.kill("SIGKILL");
        finish(() => reject(error));
      }
    });
    child.once("error", (error) => finish(() => reject(new BlueIrisError(
      "MEDIA_TOOL_UNAVAILABLE",
      `${command} is unavailable in the ALPR runtime.`,
      { cause: error }
    ))));
    child.once("close", (code, signal) => finish(() => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new BlueIrisError(
        "MEDIA_TOOL_FAILED",
        `${command} failed while processing the temporary Blue Iris export.`,
        { details: {
          exitCode: Number.isInteger(code) ? code : null,
          signal: signal || null,
          stderr: stderr.toString("utf8").trim().slice(0, 2_000),
        } }
      ));
    }));
  });
}

export async function probeTimelineExport(filePath, {
  commandRunner = runMediaCommand,
} = {}) {
  const result = await commandRunner("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,start_time,size:stream=index,codec_type,codec_name,width,height",
    "-of", "json",
    path.resolve(filePath),
  ]);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new BlueIrisError("EXPORT_PROBE_INVALID", "FFprobe returned invalid export metadata.");
  }
  const video = (Array.isArray(parsed?.streams) ? parsed.streams : [])
    .find((stream) => stream?.codec_type === "video");
  const durationSeconds = Number(parsed?.format?.duration);
  const startSeconds = Number(parsed?.format?.start_time);
  const fileSize = Number(parsed?.format?.size);
  const width = Number(video?.width);
  const height = Number(video?.height);
  if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0
    || !Number.isInteger(width) || width <= 0
    || !Number.isInteger(height) || height <= 0) {
    throw new BlueIrisError("EXPORT_PROBE_INVALID", "The Blue Iris export has no valid video stream.");
  }
  return {
    codec: String(video.codec_name || "").trim() || null,
    width,
    height,
    durationMs: Math.round(durationSeconds * 1_000),
    startTimeMs: Number.isFinite(startSeconds) ? Math.round(startSeconds * 1_000) : 0,
    fileSize: Number.isFinite(fileSize) && fileSize >= 0 ? fileSize : null,
  };
}

export async function extractTimelineAnalysisFrames({
  inputPath,
  outputDirectory,
  trimStartMs = TIMELINE_EXPORT_PADDING_MS,
  commandRunner = runMediaCommand,
}) {
  const trimSeconds = Math.max(0, Number(trimStartMs) || 0) / 1_000;
  await fs.mkdir(outputDirectory, { recursive: true });
  const pattern = path.join(outputDirectory, "analysis-%03d.jpg");
  await commandRunner("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", path.resolve(inputPath),
    "-an", "-sn", "-dn",
    "-vf", [
      "setpts=PTS-STARTPTS",
      `trim=start=${trimSeconds.toFixed(3)}:duration=${(
        (TIMELINE_ANALYSIS_DURATION_MS + TIMELINE_ANALYSIS_INTERVAL_MS) / 1_000
      ).toFixed(3)}`,
      "setpts=PTS-STARTPTS",
      `fps=${1_000 / TIMELINE_ANALYSIS_INTERVAL_MS}:start_time=0`,
      `scale=min(${TIMELINE_ANALYSIS_WIDTH}\\,iw):-2:flags=lanczos`,
    ].join(","),
    "-q:v", "3", "-start_number", "0", pattern,
  ]);
  const files = (await fs.readdir(outputDirectory))
    .filter((name) => /^analysis-\d{3}\.jpg$/.test(name))
    .sort();
  if (files.length < TIMELINE_ANALYSIS_FRAME_COUNT) {
    throw new BlueIrisError(
      "EXPORT_FRAME_COUNT_INVALID",
      `The Blue Iris export yielded ${files.length} frames; ${TIMELINE_ANALYSIS_FRAME_COUNT} are required.`
    );
  }
  const selected = files.slice(0, TIMELINE_ANALYSIS_FRAME_COUNT);
  return Promise.all(selected.map(async (name, index) => ({
    index,
    offsetMs: index * TIMELINE_ANALYSIS_INTERVAL_MS,
    path: path.join(outputDirectory, name),
    buffer: await fs.readFile(path.join(outputDirectory, name)),
  })));
}

export async function extractTimelineFinalFrame({
  inputPath,
  outputPath,
  trimStartMs = TIMELINE_EXPORT_PADDING_MS,
  selectedFrameIndex,
  commandRunner = runMediaCommand,
}) {
  const trimSeconds = Math.max(0, Number(trimStartMs) || 0) / 1_000;
  const frameIndex = Number.parseInt(String(selectedFrameIndex), 10);
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= TIMELINE_ANALYSIS_FRAME_COUNT) {
    throw new BlueIrisError("FINAL_FRAME_INDEX_INVALID", "The selected timeline frame index is invalid.");
  }
  await commandRunner("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", path.resolve(inputPath),
    "-vf", [
      "setpts=PTS-STARTPTS",
      `trim=start=${trimSeconds.toFixed(3)}:duration=${(
        (TIMELINE_ANALYSIS_DURATION_MS + TIMELINE_ANALYSIS_INTERVAL_MS) / 1_000
      ).toFixed(3)}`,
      "setpts=PTS-STARTPTS",
      `fps=${1_000 / TIMELINE_ANALYSIS_INTERVAL_MS}:start_time=0`,
      `select=eq(n\\,${frameIndex})`,
    ].join(","),
    "-frames:v", "1", "-vsync", "vfr", "-an", "-sn", "-dn",
    "-q:v", "1", "-y", path.resolve(outputPath),
  ]);
  const buffer = await fs.readFile(outputPath);
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new BlueIrisError("FINAL_FRAME_INVALID", "FFmpeg did not extract a valid final JPEG.");
  }
  return buffer;
}

function assertWorkspaceInsideRoot(root, workspace) {
  const relative = path.relative(path.resolve(root), path.resolve(workspace));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new BlueIrisError("UNSAFE_TEMPORARY_PATH", "Refusing to modify an unsafe export workspace.");
  }
}

export async function createTimelineExportWorkspace({ root = DEFAULT_TEMPORARY_ROOT } = {}) {
  const resolvedRoot = path.resolve(root);
  await fs.mkdir(resolvedRoot, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(resolvedRoot, "job-"));
  assertWorkspaceInsideRoot(resolvedRoot, workspace);
  return {
    root: resolvedRoot,
    workspace,
    clipPath: path.join(workspace, "timeline.mp4"),
    framesDirectory: path.join(workspace, "frames"),
    finalFramePath: path.join(workspace, "selected.jpg"),
  };
}

export async function removeTimelineExportWorkspace({ root, workspace }) {
  assertWorkspaceInsideRoot(root, workspace);
  await fs.rm(path.resolve(workspace), { recursive: true, force: true });
}

export async function sweepTimelineExportWorkspaces({
  root = DEFAULT_TEMPORARY_ROOT,
  olderThanMs = 60 * 60_000,
  now = Date.now(),
} = {}) {
  const resolvedRoot = path.resolve(root);
  let entries;
  try {
    entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: 0 };
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("job-")) continue;
    const workspace = path.join(resolvedRoot, entry.name);
    assertWorkspaceInsideRoot(resolvedRoot, workspace);
    const stats = await fs.stat(workspace);
    if (now - stats.mtimeMs < olderThanMs) continue;
    await fs.rm(workspace, { recursive: true, force: true });
    removed += 1;
  }
  return { removed };
}

export const blueIrisTimelineMediaInternals = Object.freeze({
  assertWorkspaceInsideRoot,
  DEFAULT_TEMPORARY_ROOT,
});
