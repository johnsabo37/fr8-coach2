// server.js
// Minimal Express server with site-wide Basic Auth + static pages from /public.
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
    return res.status(500).send("Server not configured (SITE_PASSWORD missing).");
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
    if (user === USER && pass === PASS) return next();
  } catch {}
  res.set("WWW-Authenticate", 'Basic realm="Protected"');
  return res.status(401).send("Authentication required.");
});

// ---- Serve static files from /public ----
app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"], // so /ad
