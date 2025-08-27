// server.js — true random lead sampling across full set + clean company names

const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

// ----- Env -----
const PORT = process.env.PORT || 10000;
const SITE_PASSWORD = (process.env.SITE_PASSWORD || "").trim(); // leave blank to disable site password
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();
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

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ----- Health -----
app.get("/api/ping", (req, res) => res.json({ ok: true, message: "pong" }));

// ----- Public API auth (skipped if SITE_PASSWORD blank) -----
app.use("/api", (req, res, next) => {
  if (req.path === "/ping") return next();
  if (!SITE_PASSWORD) return next();
  if (req.headers["x-site-password"] !== SITE_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ===== Cards (Sales & Ops) =====
app.get("/api/cards", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
    const type = (req.query.type || "sales").toLowerCase();
    const table = type === "ops" ? "ops_cards" : "sales_cards";
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(12);
    if (error) throw error;
    res.json({ source: table, cards: data || [] });
  } catch (e) {
    console.error("Supabase error (/api/cards):", e.message || e);
    res.status(500).json({ error: "Supabase query failed" });
  }
});

// ===== Utilities for Leads =====

// Clean a title like 'Lead List 1.1 — "ACME, INC."' into 'ACME, INC.'
function cleanCompanyTitle(raw) {
  if (!raw) return "";
  let t = String(raw).trim();

  // If there is an em dash or hyphen separating list name and company, keep the RHS
  const dashIdx = t.indexOf("—"); // em dash
  if (dashIdx >= 0 && dashIdx < t.length - 1) {
    t = t.slice(dashIdx + 1).trim();
  } else {
    // sometimes a hyphen is used instead of em dash with spaces " - "
    const hyIdx = t.indexOf(" - ");
    if (hyIdx >= 0 && hyIdx < t.length - 1) t = t.slice(hyIdx + 3).trim();
  }

  // Strip surrounding quotes if present
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }

  // Remove stray leading/trailing quotes
  t = t.replace(/^["']+|["']+$/g, "").trim();

  return t;
}

// Fetch total count for a given filter (exact 'Leads' or ilike/tag fallback)
async function countLeadsExact() {
  const { count, error } = await supabase
    .from("kb_docs")
    .select("id", { count: "exact", head: true })
    .eq("source_type", "Leads");
  if (error) {
    console.error("countLeadsExact error:", error);
    return 0;
  }
  return count || 0;
}

async function countLeadsFallback() {
  const { count, error } = await supabase
    .from("kb_docs")
    .select("id", { count: "exact", head: true })
    .or("source_type.ilike.%lead%,tags.ilike.%lead%");
  if (error) {
    console.error("countLeadsFallback error:", error);
    return 0;
  }
  return count || 0;
}

// Fetch one row by random offset using the given mode
async function fetchLeadByOffset(offset, mode = "exact") {
  let query = supabase.from("kb_docs").select("id,title,source_type,tags").range(offset, offset);
  if (mode === "exact") {
    query = query.eq("source_type", "Leads");
  } else {
    query = query.or("source_type.ilike.%lead%,tags.ilike.%lead%");
  }
  const { data, error } = await query;
  if (error) {
    console.error("fetchLeadByOffset error:", error);
    return null;
  }
  return (data && data[0]) ? data[0] : null;
}

// Truly random sample of N leads across the full set
async function fetchRandomLeadsTrueRandom(n = 10) {
  if (!supabase) return [];

  // Try exact 'Leads' first
  let mode = "exact";
  let total = await countLeadsExact();

  // If none found, use fallback (ILIKE / tag)
  if (!total || total <= 0) {
    mode = "fallback";
    total = await countLeadsFallback();
  }
  if (!total || total <= 0) return [];

  const picks = [];
  const seenIds = new Set();

  // Cap attempts to avoid infinite loop if duplicates happen
  const attemptsMax = n * 8;
  let attempts = 0;

  while (picks.length < n && attempts < attemptsMax) {
    attempts++;
    const randOffset = Math.floor(Math.random() * total); // 0..total-1
    const row = await fetchLeadByOffset(randOffset, mode);
    if (!row) continue;
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    const company = cleanCompanyTitle(row.title);
    if (company) picks.push(company);
  }

  return picks;
}

// ===== Coach =====
app.post("/api/coach", async (req, res) => {
  try {
    const { prompt, history = [], userEmail } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const q = (prompt || "").trim();

    // Leads request: pull truly random + clean names
    if (/\blead(s)?\b/i.test(q) || /prospect(s)?/i.test(q)) {
      const leads = await fetchRandomLeadsTrueRandom(10);
      if (leads.length === 0) {
        return res.json({
          reply:
            "No leads found yet.\n\nTo add leads: go to /admin, choose Source Type “Leads”, and upload a .txt file with ONE COMPANY PER LINE."
        });
      }
      return res.json({
        reply:
          "Here are 10 leads from your library:\n\n" +
          leads.map((c, i) => `${i + 1}. ${c}`).join("\n")
      });
    }

    // Normal coaching flow…
    const org = (userEmail && userEmail.split("@")[1] || "").toLowerCase();
    const isShipWMT = org === "shipwmt.com";

    async function fetchNotes(topic, textQ = "", limit = 6) {
      if (!supabase) return [];
      let qry = supabase.from("kb_notes").select("topic, content, created_at").eq("topic", topic);
      if (textQ) qry = qry.or(`content.ilike.%${textQ}%`);
      const { data, error } = await qry.order("created_at", { ascending: false }).limit(limit);
      if (error || !data) return [];
      return data;
    }

    const shipwmtMatches = await fetchNotes("ShipWMT Coaching", q, 6);
    const industryMatches = await fetchNotes("Industry Insights", q, 6);

    let shipwmtFallback = [];
    if (shipwmtMatches.length === 0 && supabase) {
      const { data } = await supabase
        .from("kb_notes")
        .select("topic, content, created_at")
        .eq("topic", "ShipWMT Coaching")
        .order("created_at", { ascending: false })
        .limit(2);
      shipwmtFallback = data || [];
    }

    const blended = [
      ...shipwmtMatches.slice(0, 4),
      ...shipwmtFallback.slice(0, Math.max(0, 4 - shipwmtMatches.length)),
      ...industryMatches.slice(0, 2),
    ].filter(Boolean);

    const contextBlock = blended.length
      ? `Context snippets (prioritized: ShipWMT Coaching):\n` +
        blended.map((n, i) => `[${i + 1}] (${n.topic}) ${n.content}`).join("\n---\n")
      : `No KB matches found; prefer ShipWMT Coaching guidance and approved sources.`;

    const approvedSources = [
      "Internal SOPs/KB (ShipWMT Coaching) — refer to Windmill Transport when mentioning company name",
      "Sales creators: Darren McKee, Jacob Karp, Will Jenkins, Stephen Mathis, Kevin Dorsey",
      "Industry experts: Craig Fuller, Chris Pickett, Brittain Ladd, Brad Jacobs, Eric Williams, Ken Adamo",
      "Companies/outlets: FreightWaves/SONAR, DAT, RXO, FedEx, UPS, Walmart (and similar reputable sources)",
    ].join("; ");

    const shipwmtFocus = isShipWMT
      ? `Primary audience: employees of Windmill Transport (shipwmt.com). Emphasize disciplined prospecting, one-lane trials with explicit success criteria, proactive track-and-trace, carrier vetting & scorecards, margin protection, clear escalation, and data-backed context (DAT, SONAR).`
      : `Primary audience: internal brokerage team; when referring to company, use Windmill Transport.`;

    const systemMsg =
`You are Fr8Coach, an expert freight brokerage coach for an internal team.
${shipwmtFocus}
Approved sources (priority): ${approvedSources}
Style: concise checklists, concrete scripts, measurable next steps.
Cite snippets like [1], [2] that correspond to the context block.

${contextBlock}
`;

    if (!openai) return res.status(500).json({ error: "OpenAI not configured" });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemMsg },
        ...history,
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 600,
    });

    res.json({ reply: completion.choices?.[0]?.message?.content || "No reply" });
  } catch (e) {
    const msg = (e?.error?.message || e?.message || "").toLowerCase();
    if (e?.status === 429 || msg.includes("quota")) {
      return res.json({
        reply:
`(Demo reply – OpenAI quota/rate limit)
Playbook:
1) Clarify lane, commodity, timing.
2) Offer 1-lane trial with explicit success metrics (OTP %, OTIF, tracking cadence).
3) Confirm next step with date/time and stakeholder.`
      });
    }
    console.error("OpenAI error (/api/coach):", e.status || "", e.message || "", e.response?.data || e);
    res.status(500).json({ error: "OpenAI call failed", detail: e.message || "unknown error" });
  }
});

// ===== Admin-only endpoints (placeholder; keep your existing upload route if you have one) =====
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: "Admin password not configured" });
  if (req.headers["x-admin-password"] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized (admin)" });
  }
  next();
}

app.post("/api/admin/upload", requireAdmin, async (req, res) => {
  res.json({ ok: true, message: "Upload endpoint placeholder — your existing code goes here." });
});

// ----- Frontend -----
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ----- Start -----
app.listen(PORT, () => console.log(`Fr8Coach running on port ${PORT}`));
