import { requireApiKey } from "@/lib/auth";
import { ensureInitialized } from "../_startup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  try {
    await ensureInitialized();
    const { apiKey } = await request.json();
    console.log("Checking API key");
    const result = await requireApiKey(apiKey);

    if (result.ok) {
      return Response.json({ valid: true });
    }

    return Response.json(
      { valid: false, error: result.error },
      { status: result.status }
    );
  } catch (error) {
    console.error("Error verifying API key:", error);
    return Response.json(
      { error: "Authentication storage temporarily unavailable" },
      { status: 503 }
    );
  }
}
