// server.js — Fr8Coach
// Adds site-wide Basic Auth *before* all routes
// while keeping every existing API and bot feature unchanged.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

// ===== Env =====
const PORT = process.env.PORT || 10000;
const BASIC_USER = process.env.SITE_USER || "user";      // <-- popup username
const BASIC_PASS = process.env.SITE_PASSWORD || "";      // <-- popup password
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ""; // admin secret
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

// ===== App =====
const app = express();

// ---- NEW: browser popup Basic Auth (before everything else) ----
app.use((req, res, next) => {
  if (!BASIC_PASS) return next(); // if not configured, skip
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="fr8coach"');
    return res.status(401).send("Authentication required.");
  }
  try {
    const [user, pass] = Buffer.from(auth.split(" ")[1], "base64").toString().split(":");
    if (user === BASIC_USER && pass === BASIC_PASS) return next();
  } catch {}
  res.set("WWW-Authenticate", 'Basic realm="fr8coach"');
  return res.status(401).send("Authentication required.");
});

// ---- existing middleware ----
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ===== Health check =====
app.get("/api/ping", (_req, res) => res.json({ ok: true, message: "pong" }));

// Gate non-admin /api routes with SITE_PASSWORD header
app.use("/api", (req, res, next) => {
  if (req.path === "/ping") return next();
  if (req.path.startsWith("/admin/")) return next();
  if (req.headers["x-site-password"] !== BASIC_PASS) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ===== Admin AUTH helpers =====
function normalizeSecret(s) {
  if (typeof s !== "string") return "";
  return s.replace(/^["']|["']$/g, "").normalize("NFKC").trim();
}
const ADMIN_SECRET = normalizeSecret(ADMIN_PASSWORD || "");
function timingSafeEqualAtoB(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function isAdminAuthorized(req) {
  const hdr = normalizeSecret(req.headers["x-admin-password"] || "");
  if (
