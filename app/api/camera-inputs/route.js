import { getPool } from "@/lib/db";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";
import { CameraInputRepository } from "@/lib/camera-inputs/repository.mjs";
import { InputError, readAxisRequest } from "@/lib/camera-inputs/axis.mjs";
import { refreshCameraInputs } from "@/lib/camera-inputs/runtime.mjs";

export async function GET() {
  const denied = await denyUnlessRoutePermission("system.manage_settings");
  if (denied) return denied;
  try {
    const pool = await getPool();
    const [inputs, brokers] = await Promise.all([
      new CameraInputRepository(pool).list(),
      pool.query(
        "SELECT id,name,broker,port,enabled FROM public.mqttbrokers ORDER BY name",
      ),
    ]);
    return Response.json(
      { inputs, brokers: brokers.rows },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Unable to load camera inputs" },
      { status: 503 },
    );
  }
}
export async function POST(request) {
  const denied = await denyUnlessRoutePermission("system.manage_settings");
  if (denied) return denied;
  try {
    const data = await readAxisRequest(request, 64 * 1024);
    if (!data || Array.isArray(data) || typeof data !== "object")
      throw new InputError("Expected camera settings");
    const repository = new CameraInputRepository(await getPool());
    const result = await repository.save(data, data.id || null);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status =
      error instanceof InputError
        ? error.status
        : error?.code === "23505"
          ? 409
          : error?.code === "23503" || error?.code === "22P02"
            ? 400
            : 503;
    return Response.json(
      {
        error:
          error instanceof InputError
            ? error.message
            : status === 409
              ? "That camera name or device is already configured"
              : status === 400
                ? "Invalid camera or broker selection"
                : "Unable to save camera settings",
      },
      { status },
    );
  }
}

export async function DELETE(request) {
  const denied = await denyUnlessRoutePermission("system.manage_settings");
  if (denied) return denied;
  try {
    const data = await readAxisRequest(request, 64 * 1024);
    if (!data || Array.isArray(data) || typeof data !== "object")
      throw new InputError("Expected a camera input to delete");
    const result = await new CameraInputRepository(await getPool()).remove(data);
    refreshCameraInputs();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof InputError ? error.message : "Unable to delete camera input" },
      { status: error instanceof InputError ? error.status : 503 },
    );
  }
}
