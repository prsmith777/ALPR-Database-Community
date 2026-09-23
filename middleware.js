import { NextResponse } from "next/server";
import { createMiddlewareHandler } from "./lib/middleware-auth.mjs";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|grid.svg).*)"],
};

const handleMiddleware = createMiddlewareHandler({
  next: () => NextResponse.next(),
  redirect: (url) => NextResponse.redirect(url),
  json: (body, init) => NextResponse.json(body, init),
});

export async function middleware(request) {
  return await handleMiddleware(request);
}
