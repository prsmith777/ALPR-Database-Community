import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({ error: "IP login bypass is retired. Create read-only display access in Home Assistant settings." }, { status: 410 });
}
