import { NextResponse } from "next/server.js";


function getApiCredential(request) {
  if (request.nextUrl.searchParams.has("api_key")) {
    return { rejected: true, apiKey: null };
  }

  const headerApiKey = request.headers.get("x-api-key");
  if (headerApiKey) {
    return { rejected: false, apiKey: headerApiKey };
  }

  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return { rejected: false, apiKey: bearerMatch[1] };
  }

  return { rejected: false, apiKey: null };
}

export async function authorizeApiKeyRequest(request) {
  const { rejected, apiKey } = getApiCredential(request);
  if (rejected || !apiKey) {
    return { ok: false, status: 401 };
  }

  try {
    const response = await fetch(new URL("/api/verify-key", request.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      let result;
      try {
        result = await response.json();
      } catch {
        return { ok: false, status: 503 };
      }

      if (typeof result?.valid !== "boolean") {
        return { ok: false, status: 503 };
      }

      return result.valid
        ? { ok: true, status: 200 }
        : { ok: false, status: 401 };
    }

    return { ok: false, status: response.status >= 500 ? 503 : 401 };
  } catch (error) {
    console.error("API authentication temporarily unavailable");
    return { ok: false, status: 503 };
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|grid.svg).*)"],
  runtime: "nodejs",
};

export async function middleware(request) {
  console.log(`${request.method} ${request.nextUrl.pathname}`);

  const publicPaths = [
    "/_next",
    "/favicon.ico",
    "/api/verify-session",
    "/api/health-check",
    "/api/verify-key",
    "/api/verify-whitelist",
    "/api/check-update",
    "/api/test",
    "/update",
    "/180.png",
    "/512.png",
    "/192.png",
    "/1024.png",
    "/grid.svg",
    "/manifest.webmanifest",
  ];

  if (request.nextUrl.pathname.startsWith("/api/plate-reads")) {
    const auth = await authorizeApiKeyRequest(request);
    if (!auth.ok) {
      return NextResponse.json(
        {
          error:
            auth.status === 503
              ? "Authentication temporarily unavailable"
              : "Unauthorized",
        },
        { status: auth.status }
      );
    }
    return NextResponse.next();
  }

  if (request.nextUrl.searchParams.has("api_key")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (publicPaths.some((path) => request.nextUrl.pathname.startsWith(path))) {
    if (request.nextUrl.pathname === "/api/plates") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response("Unauthorized", { status: 401 });
      }
      const apiKey = authHeader.replace("Bearer ", "");
      try {
        const response = await fetch(new URL("/api/verify-key", request.url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          return new Response("Invalid API Key", { status: 401 });
        }
      } catch (error) {
        console.error("API authentication temporarily unavailable");
        return new Response("Internal Server Error", { status: 500 });
      }
    }
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    const auth = await authorizeApiKeyRequest(request);
    if (!auth.ok) {
      return NextResponse.json(
        {
          error:
            auth.status === 503
              ? "Authentication temporarily unavailable"
              : "Unauthorized",
        },
        { status: auth.status }
      );
    }
    return NextResponse.next();
  }

  // --- REFINED SESSION COOKIE CHECK ---
  const sessionCookie = request.cookies.get("session");
  const sessionId = sessionCookie ? sessionCookie.value : null; // Explicitly get value or null

  console.log(
    `Middleware checking path: ${request.nextUrl.pathname}, session cookie present: ${Boolean(sessionId)}`
  );

  // SPECIAL HANDLING FOR LOGIN PAGE
  if (request.nextUrl.pathname === "/login") {
    if (sessionId) {
      // Check if sessionId exists
      try {
        const response = await fetch(
          new URL("/api/verify-session", request.url),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }), // Pass sessionId directly
            signal: AbortSignal.timeout(5000),
          }
        );

        if (response.ok) {
          const result = await response.json();
          if (result.valid) {
            console.log(
              "Authenticated user accessing login, redirecting to home"
            );
            return NextResponse.redirect(new URL("/", request.url));
          }
          return NextResponse.next();
        }
      } catch (error) {
        console.error("Session verification failed on login page");
        const res = NextResponse.next();
        res.cookies.delete("session"); // Clear potentially invalid session
        return res;
      }
    }
    return NextResponse.next(); // No valid session, allow access to login page
  }

  // For all other protected routes, check authentication
  if (!sessionId) {
    // Now this check should correctly reflect if a session ID was found
    console.log(
      "No session ID found in cookie. Checking IP whitelist or redirecting to login."
    );
    // Check IP whitelist (existing logic, kept as is)
    try {
      const isWhitelistedIpResponse = await fetch(
        new URL("/api/verify-whitelist", request.url),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ip: request.ip,
            headers: Object.fromEntries(request.headers),
          }),
          signal: AbortSignal.timeout(5000),
        }
      );

      if (isWhitelistedIpResponse.ok) {
        const isWhitelistedIp = (await isWhitelistedIpResponse.json()).allowed;
        if (isWhitelistedIp) {
          console.log("IP whitelisted, allowing access.");
          return NextResponse.next();
        }
      }
    } catch (error) {
      console.error("IP whitelist check failed");
    }

    console.log("No session or IP not whitelisted, redirecting to /login.");
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Session verification for protected routes
  try {
    const response = await fetch(new URL("/api/verify-session", request.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }), // Pass sessionId directly
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.error(
        `Session verification request failed: ${response.status} for path: ${request.nextUrl.pathname}`
      );
      if (response.status >= 400 && response.status < 500) {
        console.log(
          "Client error during session verification, redirecting to login and clearing cookie."
        );
        const res = NextResponse.redirect(new URL("/login", request.url));
        res.cookies.delete("session");
        return res;
      } else {
        console.log(
          "Server error during session verification, redirecting to login."
        );
        return NextResponse.redirect(new URL("/login", request.url));
      }
    }

    const result = await response.json();

    if (!result.valid) {
      console.log(
        "Invalid session for protected route, clearing cookie and redirecting to login."
      );
      const res = NextResponse.redirect(new URL("/login", request.url));
      res.cookies.delete("session");
      return res;
    }

    if (!request.nextUrl.pathname.startsWith("/api/")) {
      try {
        const updateResponse = await fetch(
          new URL("/api/check-update", request.url),
          { signal: AbortSignal.timeout(5000) }
        );
        if (updateResponse.ok) {
          const updateData = await updateResponse.json();
          if (updateData.updateRequired) {
            return NextResponse.redirect(new URL("/update", request.url));
          }
        }
      } catch (error) {
        console.error("Update check failed");
      }
    }
    return NextResponse.next();
  } catch (error) {
    console.error("Session verification request failed in middleware");
    if (error.name === "AbortError") {
      console.log("Session verification timeout, redirecting to login.");
    } else {
      console.log(
        "Network error during session verification, redirecting to login."
      );
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }
}
