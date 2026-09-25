import { randomUUID } from "node:crypto";

function safeBuilderName() {
  return `alpr-community-build-${process.pid}-${randomUUID().slice(0, 8)}`;
}

export function buildRuntimeImage(runner, root, release, image) {
  const builder = safeBuilderName();
  let buildError;
  runner("docker", [
    "buildx", "create", "--name", builder, "--driver", "docker-container",
  ], { cwd: root, quiet: true });
  try {
    runner("docker", [
      "buildx", "build", "--builder", builder, "--pull", "--load", "--tag", image,
      "--label", `org.opencontainers.image.version=${release.version}`,
      "--label", `org.opencontainers.image.revision=${release.commit}`,
      "--label", "org.opencontainers.image.source=https://github.com/prsmith777/ALPR-Database-Community",
      ".",
    ], { cwd: root, inherit: true });
  } catch (error) {
    buildError = error;
    throw error;
  } finally {
    try {
      runner("docker", ["buildx", "rm", "--force", builder], { cwd: root, quiet: true });
    } catch (cleanupError) {
      if (!buildError) {
        try {
          runner("docker", ["image", "rm", image], { cwd: root, quiet: true });
        } catch {
          // The cleanup failure below remains authoritative and identifies the
          // exact temporary builder for manual recovery.
        }
        throw new Error(`runtime image was built, but temporary builder ${builder} could not be removed: ${cleanupError.message}`);
      }
    }
  }
}

export const communityImageBuilderInternals = Object.freeze({ safeBuilderName });
