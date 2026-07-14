import { requireApiKey } from "@/lib/authz";
import { ensureInitialized } from "../_startup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  await ensureInitialized();

  try {
    const result = await requireApiKey(request);
    if (result.ok) return Response.json({ valid: true });
    return Response.json({ valid: false }, { status: 401 });
  } catch (error) {
    console.error("Error verifying API key");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
