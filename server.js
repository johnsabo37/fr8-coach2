// server.js (single-folder, Render-ready)

const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

// ----- Config from env -----
const PORT = process.env.PORT || 10000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// ----- Clients -----
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

// ----- Health -----
app.get("/api/ping", (req, res) => res.json({ ok: true, message: "pong" }));

// ----- Simple auth gate for all /api routes -----
app.use("/api", (req, res, next) => {
  if (req.path === "/ping") return next(); // allow ping without password
  if (req.headers["x-site-password"] !== SITE_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ----- Cards (Supabase) -----
app.get("/api/cards", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
    const type = (req.query.type || "sales").toLowerCase();
    const table = type === "ops" ? "ops_cards" : "sales_cards";
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) throw error;
    res.json({ source: table, cards: data || [] });
  } catch (e) {
    console.error("Supabase error:", e.message || e);
    res.status(500).json({ error: "Supabase query failed" });
  }
});

// ----- Coach (OpenAI) -----
app.post("/api/coach", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });
    if (!openai) return res.status(500).json({ error: "OpenAI not configured" });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
  messages: [
  {
    role: "system",
    content:
`You are Fr8Coach, a freight brokerage coach.
Authoritative sources (in order): 1) Our internal SOPs/KB, 2) Ops best practices we have explicitly stored. 3) Content from Freightwaves, SONAR, DAT, CH Robinson, RXO Logistics, 4)Sales creators: Craig Fuller, Ken Adamo, Eric Williams, Darren McKee, Jacob Karp, Will Jenkins, Stephen Mathis, Kevin Dorsey, 
If a question requires content outside those, say: "I don’t have that in the approved sources." 
Prefer concise, step-by-step checklists and cite the source names you used at the end.`
  },
  { role: "user", content: prompt }
]

      temperature: 0.3,
      max_tokens: 300
    });

    res.json({ reply: completion.choices?.[0]?.message?.content || "No reply" });
  } catch (e) {
    console.error("OpenAI error:", e.status || "", e.message || "", e.response?.data || e);
    res.status(500).json({ error: "OpenAI call failed", detail: e.message || "unknown error" });
  }
});

// ----- Frontend fallback (prevents ENOTDIR/Not Found at /) -----
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ----- Start server -----
app.listen(PORT, () => {
  console.log(`Fr8Coach running on port ${PORT}`);
});
