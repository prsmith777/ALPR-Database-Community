import { randomBytes } from "node:crypto";
import { getPool } from "@/lib/db";
import { HomeAssistantDisplayService, displayHeaders } from "@/lib/home-assistant-display.mjs";
import { displayDocument } from "@/lib/home-assistant-display-document.mjs";

export const dynamic = "force-dynamic";
export async function GET(_request, { params }) {
  try {
    const { grantId } = await params;
    const grant = await new HomeAssistantDisplayService(await getPool()).publicGrant(grantId);
    if (!grant) return new Response("Display expired, revoked or unavailable.", { status: 404, headers: displayHeaders });
    const nonce = randomBytes(18).toString("base64");
    return new Response(displayDocument(nonce), { headers: {
      ...displayHeaders, "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' blob:; frame-ancestors ${grant.allowed_origin}; base-uri 'none'; form-action 'none'`,
    } });
  } catch { return new Response("Display temporarily unavailable.", { status: 503, headers: displayHeaders }); }
}
