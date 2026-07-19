export async function getLocalVersionInfo() {
  try {
    const localVersion = require("../package.json").version;
    return localVersion;
  } catch (error) {
    console.error("Error getting local version:", error);
    return "unknown";
  }
}
