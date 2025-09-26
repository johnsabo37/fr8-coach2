// middleware.ts (Next.js)
// Purpose: Block all requests unless a valid, signed auth cookie is present.
// Works on Render behind HTTPS (Secure cookies).

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import crypto from "crypto";

// IMPORTANT: In Render → Service → Environment, set SESSION_SECRET to a long random string.
const SESSION_SECRET = process.env.SESSION_SECRET || "";

/** Validate our cookie format: "<issuedAt>.<hmac>" where hmac = HMAC_SHA256(issuedAt, SESSION_SECRET) */
function validToken(token?: string) {
  if (!token || !SESSION_SECRET) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [issuedAt, mac] = parts;

  // Minimal sanity check on issuedAt.
  if (!/^\d{10,}$/.test(issuedAt)) return false;

  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(issuedAt).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public routes: login page, login API, Next build assets, basic static files
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/_site-login") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/robots.txt") ||
    pathname.startsWith("/static")
  ) {
    return NextResponse.next();
  }

  // Everything else requires a valid cookie
  const token = req.cookies.get("site_auth")?.value;
  if (validToken(token)) return NextResponse.next();

  // Not authenticated → go to /login and remember where the user wanted to go
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

// Tell Next which paths to run middleware on (skip image/static internals)
export const config = {
  matcher: ["/((?!_next/image|_next/static).*)"],
};
