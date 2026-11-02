import { getPool } from "@/lib/db";
import fileStorage from "@/lib/fileStorage";
import { HomeAssistantDisplayService, createDisplayReadHandler } from "@/lib/home-assistant-display.mjs";

export const dynamic = "force-dynamic";
export async function GET(request, context) {
  return createDisplayReadHandler({ service: new HomeAssistantDisplayService(await getPool()), readImage: path => fileStorage.getImage(path) })(request, context);
}
