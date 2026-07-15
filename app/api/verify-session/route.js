import { verifySession, initializeAuth } from "@/lib/auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  try {
    await initializeAuth();
    const { sessionId } = await request.json();

    if (!sessionId) {
      return NextResponse.json({ valid: false }, { status: 400 });
    }

    return NextResponse.json({ valid: await verifySession(sessionId) });
  } catch {
    console.error("Session verification failed");
    return NextResponse.json(
      { error: "Authentication service unavailable" },
      { status: 500 }
    );
  }
}
