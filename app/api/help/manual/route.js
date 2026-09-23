import { HELP_MANUAL } from "@/lib/help-manual.mjs";
import { generateHelpManualPdf } from "@/lib/help-manual-pdf.mjs";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const denied = await denyUnlessRoutePermission("plate.read");
  if (denied) return denied;

  try {
    const pdf = generateHelpManualPdf(HELP_MANUAL);
    return new Response(pdf, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${HELP_MANUAL.filename}"`,
        "Content-Length": String(pdf.length),
        "Content-Type": "application/pdf",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Help manual PDF generation failed:", error);
    return Response.json(
      { success: false, error: "Unable to create the user guide PDF." },
      { status: 500 }
    );
  }
}
