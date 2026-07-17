// app/api/health-check/route.js
import { getPool } from "@/lib/db";

export async function GET() {
  try {
    const pool = await getPool();
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return Response.json({ status: "ok" });
  } catch {
    console.error("Database health check failed");
    return Response.json(
      { status: "error" },
      { status: 503 }
    );
  }
}
