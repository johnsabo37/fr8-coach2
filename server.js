// server.js
// Express server with site-wide Basic Auth, and correct routing to each page.

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();

const USER = process.env.SITE_USER || "user";
const PASS = process.env.SITE_PASSWORD || "";

// ==== BASIC AUTH (site-wide) ====
function unauthorized(res) {
  res.set("WWW-Authenticate", 'Basic realm="Protected"');
  return res.status(401).send("Authentication required.");
}
function safeEqual(a, b) {
  const A = Buffer.from(a || "");
  const B = Buffer.from(b || "");
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}
app.use((req, res, next) => {
  if (!PASS) return res.status(500).send("Server not configured");
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) return unauthorized(res);
  let decoded = "";
  try { decoded = Buffer.from(auth.slice(6), "base64").toString("utf8"); } catch { return unauthorized(res); }
  const i = decoded.indexOf(":");
  const user = i >= 0 ? decoded.slice(0, i) : "";
  const pass = i >= 0 ? decoded.slice(i + 1) : "";
  if (safeEqual(user, USER) && safeEqual(pass, PASS)) return next();
  return unauthorized(res);
});

// ==== STATIC FILES ====
// This lets "/admin" serve "admin.html", "/sales" -> "sales.html", etc.
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

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
  console.log(`Server running on port ${port}`);
});
