import { NextResponse } from "next/server";
import fileStorage from "@/lib/fileStorage";
import path from "path";

export async function GET(request, { params }) {
  try {
    const parameters = await params;
    const [folder, ...rest] = await parameters.path;
    const filename = rest.join("/");

    const imageData = await fileStorage.getImage(path.join(folder, filename));

    if (!imageData) {
      return new NextResponse(null, { status: 404 });
    }

    const headers = new Headers();
    headers.set("Content-Type", "image/jpeg");
    headers.set("Cache-Control", "public, max-age=60");

    return new NextResponse(imageData, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("Error serving image:", error);
    return new NextResponse(null, { status: 500 });
  }
}
