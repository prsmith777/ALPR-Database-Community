import { InputError, readAxisRequest } from "./axis.mjs";
import { verifySourceCredential } from "./config.mjs";

export function createAxisReceiver({
  repository,
  wake = () => {},
  logger = console,
}) {
  return async (request, id) => {
    try {
      const input = await repository.get(id);
      if (!verifySourceCredential(request, input))
        return Response.json(
          { error: "Unauthorized" },
          {
            status: 401,
            headers: {
              "WWW-Authenticate": 'Basic realm="ALPR Axis"',
              "Cache-Control": "no-store",
            },
          },
        );
      const payload = await readAxisRequest(request);
      const result = await repository.receive(input, payload, "http");
      try {
        wake();
      } catch {
        /* The durable worker also polls as a fallback. */
      }
      // Success acknowledges durable receipt, including idempotent redelivery.
      return Response.json(
        { accepted: true, duplicate: result.duplicate },
        { status: 200 },
      );
    } catch (error) {
      if (error instanceof InputError)
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      logger.error?.("axis_http_receipt_failed", {
        code: error?.code || "DATABASE_ERROR",
      });
      return Response.json(
        { error: "Unable to store event; retry later" },
        { status: 503 },
      );
    }
  };
}
