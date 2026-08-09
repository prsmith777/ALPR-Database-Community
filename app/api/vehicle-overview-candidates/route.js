import { createIntegrationRouteHandler } from "@/lib/request-auth.mjs";

async function rejectDeprecatedOverviewCandidate() {
  return Response.json({
    accepted: false,
    deprecated: true,
    error: "Street Overview is retrieved directly from the plate-read timestamp; no Blue Iris motion action is required.",
  }, { status: 410 });
}

export const POST = createIntegrationRouteHandler(rejectDeprecatedOverviewCandidate);
