// server.js (CommonJS, Render-ready)
// Password-gated APIs, Sales/Ops cards (Supabase), history-aware coach,
// optional People Finder via SerpAPI. Company name in replies: Windmill Transport (shipwmt.com).
// Explicit routes for /sales.html, /ops.html and pretty URLs /sales, /ops.

const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

// ----- Config from env -----
const PORT = process.env.PORT || 10000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";   // required in x-site-password header
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";       // optional: for People Finder

// ----- Clients -----
const app = express();
app.use(cors());
app.use(express.json());

// Serve static files in /public (index.html, sales.html, ops.html, etc.)
app.use(express.static(path.join(__dirname, "public")));

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

// ----- Health -----
app.get("/api/ping", (req, res) => res.json({ ok: true, message: "pong" }));

// ----- Simple auth gate for all /api routes (password required) -----
app.use("/api", (req, res, next) => {
  if (req.path === "/ping") return next(); // allow ping without password
  if (req.headers["x-site-password"] !== SITE_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ----- Cards (Supabase): /api/cards?type=sales|ops -----
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
      .limit(8);

    if (error) throw error;
    res.json({ source: table, cards: data || [] });
  } catch (e) {
    console.error("Supabase error:", e.message || e);
    res.status(500).json({ error: "Supabase query failed" });
  }
});

// ----- Helper: company detection from text (for People Finder) -----
function normalizeCompany(c) {
  if (!c) return "";
  let s = c.trim().replace(/[?.,;:]+$/g, "");
  const STOPS = [" to ", " for ", " about ", " regarding ", " re ", " in ", " on "];
  for (const stop of STOPS) {
    const idx = s.toLowerCase().indexOf(stop.trim());
    if (idx > 0) {
      const re = new RegExp(`\\s${stop.trim()}\\s`, "i");
      s = s.split(re)[0];
      break;
    }
  }
  if (/^home\s*depot$/i.test(s)) s = "The Home Depot";
  if (/^walmart$/i.test(s))     s = "Walmart";
  if (/^ups$/i.test(s))         s = "UPS";
  if (/^fedex$/i.test(s))       s = "FedEx";
  return s.trim();
}

function detectCompanyFromText(text) {
  if (!text) return null;
  const q = String(text);
  const m1 =
    q.match(/who should i (?:reach out to|contact)[^@]* at ([\w .,&\-()]+)\??/i) ||
    q.match(/contacts? (?:at|for) ([\w .,&\-()]+)\??/i) ||
    q.match(/(?:get set up|set up).* at ([\w .,&\-()]+)\??/i);
  const m2 = !m1 && q.match(/\bat\s+([A-Za-z][\w .,&\-()]+)\b/);
  const raw = m1?.[1] || m2?.[1];
  return raw ? normalizeCompany(raw) : null;
}

function detectCompany(prompt, history) {
  // 1) Try current prompt
  let company = detectCompanyFromText(prompt);
  if (company) return company;

  // 2) Walk recent history (most recent last), prefer user turns
  const items = Array.isArray(history) ? history.slice().reverse() : [];
  for (const m of items) {
    if (!m || !m.content) continue;
    if (m.role !== "assistant") {
      const c = detectCompanyFromText(m.content);
      if (c) return c;
    }
  }

  // 3) As a last resort, scan assistant text too
  for (const m of items) {
    if (!m || !m.content) continue;
    const c = detectCompanyFromText(m.content);
    if (c) return c;
  }
  return null;
}

// ----- Coach (OpenAI) -----
// Accepts: { prompt, history? [{role:'user'|'assistant', content:string}] }
// Company name in replies: Windmill Transport (shipwmt.com)
app.post("/api/coach", async (req, res) => {
  try {
    const { prompt, history } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });
    const q = (prompt || "").trim();

    // 1) KB retrieval (prioritize Windmill Transport coaching, then Industry Insights)
    async function fetchNotes(topic, limit = 6) {
      if (!supabase) return [];
      const { data, error } = await supabase
        .from("kb_notes")
        .select("topic, content, created_at")
        .eq("topic", topic)
        .or(`content.ilike.%${q}%`)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error || !data) return [];
      return data;
    }

    const windmillMatches = await fetchNotes("ShipWMT Coaching", 6); // table topic remains as created
    const industryMatches = await fetchNotes("Industry Insights", 6);

    let windmillFallback = [];
    if (windmillMatches.length === 0 && supabase) {
      const { data } = await supabase
        .from("kb_notes")
        .select("topic, content, created_at")
        .eq("topic", "ShipWMT Coaching")
        .order("created_at", { ascending: false })
        .limit(2);
      windmillFallback = data || [];
    }

    const blended = [
      ...windmillMatches.slice(0, 4),
      ...windmillFallback.slice(0, Math.max(0, 4 - windmillMatches.length)),
      ...industryMatches.slice(0, 2)
    ].filter(Boolean);

    // 2) People Finder (optional) — uses company from prompt OR history
    let peopleBlock = "";
    try {
      const company = detectCompany(prompt, history);
      if (SERPAPI_KEY && company) {
        const roleQuery =
          '("transportation" OR "logistics") (sourcing OR procurement OR carrier OR delivery OR "supply chain") manager';

        async function querySerp(companyName) {
          const q1 = `site:linkedin.com/in "${companyName}" ${roleQuery}`;
          const url1 = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q1)}&num=10&api_key=${SERPAPI_KEY}`;
          const r1 = await fetch(url1);
          if (!r1.ok) return [];
          const d1 = await r1.json();
          const items1 = (d1.organic_results || []).slice(0, 10);
          return items1
            .filter(i => /linkedin\.com\/in\//i.test(i.link || i.url))
            .map(i => `- ${i.title} — ${i.link || i.url}`);
        }

        let people = await querySerp(company);
        if (!people.length) {
          const alt = company.replace(/^The\s+/i, "");
          if (alt && alt !== company) {
            people = await querySerp(alt);
          }
        }
        if (people.length) {
          peopleBlock = `\nContacts & intake — ${company}:\n${people.join("\n")}\n\n`;
        }
      }
      // If no SERPAPI_KEY or no company found, skip silently.
    } catch (_) { /* ignore people errors so coach still replies */ }

    // 3) System message (Windmill Transport-focused)
    const approvedSources = [
      "Internal SOPs/KB (ShipWMT Coaching)",
      "Sales creators: Darren McKee, Jacob Karp, Will Jenkins, Stephen Mathis, Kevin Dorsey",
      "Industry experts: Craig Fuller, Chris Pickett, Brittain Ladd, Brad Jacobs, Eric Williams, Ken Adamo",
      "Companies/outlets: FreightWaves/SONAR, DAT, RXO, FedEx, UPS, Walmart"
    ].join("; ");

    const contextBlock =
      (blended.length
        ? `Context snippets (prioritized: Windmill Transport coaching):\n` +
          blended.map((n, i) => `[${i + 1}] (${n.topic}) ${n.content}`).join("\n---\n")
        : `No KB matches found; prefer Windmill Transport coaching guidance and approved sources.`) +
      (peopleBlock ? `\n---\n${peopleBlock}` : "");

    const systemMsg = `You are Fr8Coach, an expert freight brokerage coach for employees of Windmill Transport (shipwmt.com).
Emphasize: disciplined prospecting & sequencing, one-lane trials with explicit success criteria, proactive track-and-trace, carrier vetting & scorecards, margin protection, clear escalation/SOPs, and data-backed context (DAT, SONAR).
Approved sources (priority): ${approvedSources}
Style: concise checklists, concrete scripts, measurable next steps.
Cite snippets like [1], [2] that correspond to the context block.

${contextBlock}
`;

    if (!openai) return res.status(500).json({ error: "OpenAI not configured" });

    // Build chat messages: system + (optional recent history) + current user prompt
    const historyMsgs = Array.isArray(history)
      ? history.slice(-8).map(m => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content || "").slice(0, 4000)
        }))
      : [];

    const messages = [
      { role: "system", content: systemMsg },
      ...historyMsgs,
      { role: "user", content: prompt }
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.2,
      max_tokens: 700
    });

    const modelText = completion.choices?.[0]?.message?.content || "No reply";
    const finalReply = (peopleBlock ? peopleBlock : "") + modelText;
    return res.json({ reply: finalReply });
  } catch (e) {
    const msg = (e?.error?.message || e?.message || "").toLowerCase();
    if (e?.status === 429 || msg.includes("quota")) {
      return res.json({
        reply: `(Demo reply – OpenAI quota/rate limit)
Playbook:
1) Clarify lane, commodity, timing.
2) Offer 1-lane trial with explicit success metrics (OTP %, OTIF, tracking cadence).
3) Confirm next step with date/time and stakeholder.`
      });
    }
    console.error("OpenAI error:", e.status || "", e.message || "", e.response?.data || e);
    return res.status(500).json({ error: "OpenAI call failed", detail: e.message || "unknown error" });
  }
});

// ----- Explicit routes for cards pages -----
app.get("/sales.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sales.html"));
});
app.get("/ops.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "ops.html"));
});

// Pretty URLs (optional)
app.get("/sales", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sales.html"));
});
app.get("/ops", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "ops.html"));
});

// ----- Frontend fallback (root) -----
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ----- Start server -----
app.listen(PORT, () => {
  console.log(`Fr8Coach running on port ${PORT}`);
});
