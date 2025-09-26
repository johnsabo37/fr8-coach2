// server.js
// Minimal Express server with site-wide Basic Auth + static files from /public.
// Username: process.env.SITE_USER (defaults to "user")
// Password: process.env.SITE_PASSWORD (set this in Render > Environment)

const express = require("express");
const path = require("path");

const app = express();

const USER = process.env.SITE_USER || "user";
const PASS = process.env.SITE_PASSWORD || "";

// ---- Basic Auth gate (runs before anything else) ----
app.use((req, res, next) => {
  if (!PASS) {
    return res
      .status(500)
      .send("Server not configured (SITE_PASSWORD missing).");
  }

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Protected"');
    return res.status(401).send("Authentication required.");
  }

  try {
    const decoded = Buffer.from(auth.split(" ")[1], "base64").toString("utf8"); // "user:pass"
    const i = decoded.indexOf(":");
    const user = i >= 0 ? decoded.slice(0, i) : "";
    const pass = i >= 0 ? decoded.slice(i + 1) : "";

    if (user === USER && pass === PASS) {
      return next();
    }
  } catch (e) {
    // fall through to 401 below
  }

  res.set("WWW-Authenticate", 'Basic realm="Protected"');
  return res.status(401).send("Authentication required.");
});

// ---- Serve static files from /public ----
app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"], // so /admin maps to admin.html automatically
  })
);

// ---- Homepage goes to your main page ----
// If you created/restore another file (e.g., coach.html), change "index.html" below.
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Optional clean routes (only if these files exist):
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/sales", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "sales.html"));
});
app.get("/ops", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "ops.html"));
});

// 404 for anything else (no catch-all to index.html)
app.use((_req, res) => res.status(404).send("Not found"));

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`fr8coach running on ${port}`));
