import { getSessionPrincipal, initializeAuth } from "@/lib/auth";
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

    const principal = await getSessionPrincipal(sessionId);
    return NextResponse.json({
      valid: Boolean(principal),
      mustChangePassword: Boolean(principal?.mustChangePassword),
    });
  } catch {
    console.error("Session verification failed");
    return NextResponse.json(
      { error: "Authentication service unavailable" },
      { status: 500 }
    );
  }
}
