// server.js
// Express server that protects the whole site with HTTP Basic Auth.
// Username: "user"
// Password: value of SITE_PASSWORD env var (set in Render)
// Express server with site-wide Basic Auth, and correct routing to each page.

const express = require("express");
const path = require("path");
@@ -12,61 +10,62 @@ const app = express();
const USER = process.env.SITE_USER || "user";
const PASS = process.env.SITE_PASSWORD || "";

// Helper: send auth challenge
// ==== BASIC AUTH (site-wide) ====
function unauthorized(res) {
  res.set("WWW-Authenticate", 'Basic realm="Protected"');
  return res.status(401).send("Authentication required.");
}

// Helper: timing-safe compare
function safeEqual(a, b) {
  const A = Buffer.from(a || "");
  const B = Buffer.from(b || "");
  if (A.length !== B.length) return false;
  try {
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}

// AUTH GATE — runs before any static files are served
app.use((req, res, next) => {
  if (!PASS) {
    // Your SITE_PASSWORD isn’t configured on the server
    return res.status(500).send("Server not configured");
  }

  if (!PASS) return res.status(500).send("Server not configured");
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    return unauthorized(res);
  }

  // Decode "Basic base64(user:pass)"
  if (!auth.startsWith("Basic ")) return unauthorized(res);
  let decoded = "";
  try {
    decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  } catch {
    return unauthorized(res);
  }

  const sep = decoded.indexOf(":");
  const user = sep >= 0 ? decoded.slice(0, sep) : "";
  const pass = sep >= 0 ? decoded.slice(sep + 1) : "";

  if (safeEqual(user, USER) && safeEqual(pass, PASS)) {
    return next();
  }
  try { decoded = Buffer.from(auth.slice(6), "base64").toString("utf8"); } catch { return unauthorized(res); }
  const i = decoded.indexOf(":");
  const user = i >= 0 ? decoded.slice(0, i) : "";
  const pass = i >= 0 ? decoded.slice(i + 1) : "";
  if (safeEqual(user, USER) && safeEqual(pass, PASS)) return next();
  return unauthorized(res);
});

// Serve your static site from /public
app.use(express.static(path.join(__dirname, "public")));
// ==== STATIC FILES ====
// This lets "/admin" serve "admin.html", "/sales" -> "sales.html", etc.
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// Optional: fallback to index.html for unknown routes
app.get("*", (_req, res) => {
// ==== EXPLICIT ROUTES (nice clean URLs) ====
// If you go to "/admin", send public/admin.html, etc.
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/sales", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "sales.html"));
});
app.get("/ops", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "ops.html"));
});
app.get("/coach", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "page.jsx")); // if your "coach" page is HTML, change to that filename
});

// Homepage: choose where "/" should land (pick ONE)
// Option A: serve index.html (whatever you place there)
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
// Option B (alternative): redirect "/" to /admin
// app.get("/", (_req, res) => res.redirect("/admin"));

// IMPORTANT: Do NOT use a "catch-all sends index.html" here,
// or every path will look like the same page.

// 404 for anything else:
app.use((_req, res) => res.status(404).send("Not found"));

const port = process.env.PORT || 10000;
app.listen(port, () => {
