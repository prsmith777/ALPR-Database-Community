import { createIntegrationRouteHandler } from "@/lib/request-auth.mjs";
import {
  processPlateRead,
  plateIngressLogger,
  plateIngressRecorder,
} from "@/lib/plate-read-ingestion";

export const POST = createIntegrationRouteHandler(processPlateRead, {
  integration: "blue_iris",
  routeName: "/api/plate-reads",
  logger: plateIngressLogger,
  recorder: plateIngressRecorder,
});
