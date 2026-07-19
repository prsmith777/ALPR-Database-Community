import { getCurrentAccess } from "@/app/actions";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getCurrentAccess(), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { success: false, error: "Authentication required." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
}
