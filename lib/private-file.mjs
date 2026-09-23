import fs from "fs/promises";
import path from "path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export async function ensurePrivateDirectory(directoryPath) {
  await fs.mkdir(directoryPath, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  await fs.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export async function hardenPrivateFile(filePath) {
  await fs.chmod(filePath, PRIVATE_FILE_MODE);
}

export async function writePrivateFile(filePath, contents) {
  await ensurePrivateDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, contents, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  await hardenPrivateFile(filePath);
}
