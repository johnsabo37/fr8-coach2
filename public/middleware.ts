// middleware.ts
// One-file site-wide password using HTTP Basic Auth.
// Username: "user"
// Password: value of your SITE_PASSWORD env var on Render.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Exclude Next.js internal assets so they can load
export const config = {
  matcher: ["/((?!_next|favicon.ico|robots.txt).*)"],
};

export function middleware(req: NextRequest) {
  const SITE_PASSWORD = process.env.SITE_PASSWORD || "";

  // If password isn't configured on the server, fail CLOSED.
  if (!SITE_PASSWORD) {
    return new NextResponse("Server not configured", { status: 500 });
  }

  // Expect "Authorization: Basic base64(user:password)"
  const auth = req.headers.get("authorization") || "";

  if (auth.startsWith("Basic ")) {
    try {
      // Decode the base64 credentials using Web API available in middleware runtime
      const decoded = atob(auth.slice(6)); // "user:pass"
      const [user, pass] = decoded.split(":");

      if (user === "user" && pass === SITE_PASSWORD) {
        // Correct credentials → allow request through
        return NextResponse.next();
      }
    } catch {
      // fall through to 401
    }
  }

  // Not authenticated → ask browser to show the login prompt
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Protected"' },
  });
}
