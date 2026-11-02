import { getPool } from "@/lib/db";
import { CameraInputRepository } from "@/lib/camera-inputs/repository.mjs";
import { wakeCameraInputs } from "@/lib/camera-inputs/runtime.mjs";
import { createAxisReceiver } from "@/lib/camera-inputs/http.mjs";

export const runtime = "nodejs";
export async function POST(request, { params }) {
  const { id } = await params;
  try {
    const receiver = createAxisReceiver({
      repository: new CameraInputRepository(await getPool()),
      wake: wakeCameraInputs,
    });
    return await receiver(request, id);
  } catch {
    return Response.json(
      { error: "Event receiver unavailable; retry later" },
      { status: 503 },
    );
  }
}
