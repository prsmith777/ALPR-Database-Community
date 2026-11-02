import { pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

// Run the actual Next.js ingestion service against an isolated PostgreSQL
// database without starting the web server. Production does not use this loader.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = path.resolve(import.meta.dirname, "..", specifier.slice(2));
    for (const candidate of [
      base,
      base + ".js",
      base + ".mjs",
      base + ".jsx",
    ]) {
      if (existsSync(candidate))
        return nextResolve(pathToFileURL(candidate).href, context);
    }
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith("next/") && !specifier.endsWith(".js"))
      return nextResolve(specifier + ".js", context);
    throw error;
  }
}
