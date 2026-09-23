import { getIdentityService } from "@/lib/identity-runtime.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = await getIdentityService().getBootstrapState();
    return Response.json(
      { bootstrapped: state.bootstrapped },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch {
    return Response.json(
      { bootstrapped: true },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
