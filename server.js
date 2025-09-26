// server.js
// Express server with site-wide Basic Auth and correct routing.
//
// WHAT THIS DOES
// 1) Prompts the browser for username/password (Basic Auth) on every request.
//    - Username: process.env.SITE_USER (default "user")
//    - Password: process.env.SITE_PASSWORD  <-- set this in Render > Environment
// 2) Serves your coach bot page on "/" (i.e., fr8coach.com).
//    - By default this uses "public/page.jsx" as the coach page. Change the filename
//      below if your coach page is named differently (e.g., "coach.html").
// 3) Serves /admin, /sales, /ops from their own HTML files if those exist.
// 4) No catch-all back to index.html (prevents all routes showing the same page).

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();

// ====== BASIC AUTH CONFIG ======
const USER = process.env.SITE_USER || "user";
const PASS = process.env.SITE_PASSWORD || "";

// ====== BASIC AUTH HELPERS ======
function unauthorized(res) {
  res.set("WWW-Authenticate", 'Basic realm="Protected"');
  return res.status(401).send("Authentication required.");
}

function safeEqual(a, b) {
  const A = Buffer.from(a || "");
  const B = Buffer.from(b || "");
  if (A.length !== B.length) return false;
  try {
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

// ====== SITE-WIDE BASIC AUTH (runs before static/files) ======
app.use((req, res, next) => {
  if (!PASS) {
    // Your SITE_PASSWORD isn't configured on the server
    return res.status(500).send("Server not configured (SITE_PASSWORD missing).");
  }

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    return unauthorized(res);
  }

  // Decode "Basic base64(user:pass)"
  let decoded = "";
  try {
    decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  } catch {
    return unauthorized(res);
  }

  const i = decoded.indexOf(":");
  const user = i >= 0 ? decoded.slice(0, i) : "";
  const pass = i >= 0 ? decoded.slice(i + 1) : "";

  if (safeEqual(user, USER) && safeEqual(pass, PASS)) {
    return next();
  }
  return unauthorized(res);
});

// ====== STATIC FILES ======
// Serve files out of /public. The "extensions" option lets "/admin" resolve "admin.html".
app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html", "htm", "jsx"], // include jsx since your coach file is .jsx
  })
);

// ====== LANDING PAGE ("/") → COACH BOT PAGE ======
// If your coach page file is not "page.jsx", change "page.jsx" below to the correct filename.
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "page.jsx"));
});

// ====== CLEAN ROUTES FOR PAGES YOU STILL WANT TO ACCESS DIRECTLY ======
// These only apply if you actually have those files in /public (e.g., admin.html, sales.html, ops.html).
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/sales", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "sales.html"));
});
app.get("/ops", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "ops.html"));
});

// ====== 404 FOR ANYTHING ELSE (no catch-all to index.html) ======
app.use((_req, res) => res.status(404).send("Not found"));

// ====== START SERVER ======
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
