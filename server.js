// server.js
// Express server that protects the whole site with HTTP Basic Auth.
// Username: "user"
// Password: value of SITE_PASSWORD env var (set in Render)

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();

const USER = process.env.SITE_USER || "user";
const PASS = process.env.SITE_PASSWORD || "";

// Helper: send auth challenge
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
}

// AUTH GATE — runs before any static files are served
app.use((req, res, next) => {
  if (!PASS) {
    // Your SITE_PASSWORD isn’t configured on the server
    return res.status(500).send("Server not configured");
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

  const sep = decoded.indexOf(":");
  const user = sep >= 0 ? decoded.slice(0, sep) : "";
  const pass = sep >= 0 ? decoded.slice(sep + 1) : "";

  if (safeEqual(user, USER) && safeEqual(pass, PASS)) {
    return next();
  }
  return unauthorized(res);
});

// Serve your static site from /public
app.use(express.static(path.join(__dirname, "public")));

// Optional: fallback to index.html for unknown routes
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
