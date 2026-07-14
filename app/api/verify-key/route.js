import { getAuthConfig, verifyApiKey } from "@/lib/auth";
import { ensureInitialized } from "../_startup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  await ensureInitialized();

  try {
    const { apiKey } = await request.json();
    console.log("Checking API key");
    const keyInfo = await verifyApiKey(apiKey);

    if (keyInfo) {
      return Response.json({ valid: true, user: keyInfo.user });
    }
    return Response.json({ valid: false }, { status: 401 });
  } catch (error) {
    console.error("Error verifying API key:", error);
    return Response.json(
      { error: "Authentication service unavailable" },
      { status: 503 },
    );
  }
}
