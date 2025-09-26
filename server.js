// server.js
// Adds site-wide Basic Auth WITHOUT changing your /public files.
// Username: process.env.SITE_USER (defaults to "user")
// Password: process.env.SITE_PASSWORD

const express = require("express");
const path = require("path");

const app = express();

const USER = process.env.SITE_USER || "user";
const PASS = process.env.SITE_PASSWORD || "";

// ---- BASIC AUTH (runs before anything else) ----
app.use((req, res, next) => {
  if (!PASS) {
    // If you forgot to set SITE_PASSWORD on Render, fail closed so it's obvious.
    res.set("Content-Type", "text/plain");
    return res.status(500).send("Server not configured: SITE_PASSWORD is missing.");
  }

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="fr8coach"');
    return res.status(401).send("Authentication required.");
  }

  try {
    // Decode "Basic base64(user:pass)"
    const decoded = Buffer.from(auth.split(" ")[1], "base64").toString("utf8");
    const i = decoded.indexOf(":");
    const user = i >= 0 ? decoded.slice(0, i) : "";
    const pass = i >= 0 ? decoded.slice(i + 1) : "";
    if (user === USER && pass === PASS) return next();
  } catch {}

  res.set("WWW-Authenticate", 'Basic realm="fr8coach"');
  return res.status(401).send("Authentication required.");
});

// ---- STATIC FILES (do not change your site) ----
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// ---- HOMEPAGE (/) -> public/index.html ----
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Optional clean routes (only if these files exist)
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/sales", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "sales.html"));
});
app.get("/ops", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "ops.html"));
});

// 404
app.use((_req, res) => res.status(404).send("Not found"));

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`fr8coach running on ${port}`));
