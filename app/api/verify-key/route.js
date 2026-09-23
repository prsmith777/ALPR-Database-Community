import { verifyApiKey } from "@/lib/auth";
import { ensureInitialized } from "../_startup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  try {
    await ensureInitialized();
    const { apiKey } = await request.json();
    const valid = await verifyApiKey(apiKey);

    return Response.json({ valid }, { status: valid ? 200 : 401 });
  } catch {
    console.error("API key verification failed");
    return Response.json(
      { error: "Authentication service unavailable" },
      { status: 500 }
    );
  }
}
