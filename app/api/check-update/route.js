import { checkUpdateStatus } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const updateStatus = await checkUpdateStatus();
    return NextResponse.json({ updateRequired: !updateStatus });
  } catch (error) {
    console.error("Error checking update status:", error);
    return NextResponse.json({ updateRequired: false });
  }
}
