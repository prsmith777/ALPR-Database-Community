import { NextResponse } from "next/server";
import fileStorage from "@/lib/fileStorage";
import path from "path";
import crypto from "node:crypto";

export async function GET(request, { params }) {
  const startedAt = performance.now();
  try {
    const parameters = await params;
    const [folder, ...rest] = await parameters.path;
    const filename = rest.join("/");

    const imageData = await fileStorage.getImage(path.join(folder, filename));

    if (!imageData) {
      return new NextResponse(null, { status: 404 });
    }

    const etag = `"${crypto.createHash("sha256").update(imageData).digest("base64url").slice(0, 24)}"`;
    const headers = new Headers();
    headers.set("Content-Type", "image/jpeg");
    headers.set("Cache-Control", "private, max-age=86400, immutable");
    headers.set("ETag", etag);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Server-Timing", `image;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`);

    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers });
    }

    return new NextResponse(imageData, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("Error serving image:", error);
    return new NextResponse(null, { status: 500 });
  }
}
