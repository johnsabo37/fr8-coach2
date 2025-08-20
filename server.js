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
  .from(table) // uses 'ops_cards' or 'sales_cards'
  .select('*')
  .order('priority', { ascending: false })
  .order('created_at', { ascending: false })
  .limit(5);
// People finder via SerpAPI (no scraping behind logins)
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

app.post('/api/people', async (req, res) => {
  try {
    if (req.headers["x-site-password"] !== SITE_PASSWORD) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { company, roleQuery } = req.body || {};
    if (!company) return res.status(400).json({ error: "Missing company" });

    const out = { company, query: roleQuery || "", vendor: [], people: [] };

    // Optional: your curated vendor paths from Supabase (if you created `vendor_paths`)
    try {
      if (supabase) {
        const vp = await supabase
          .from('vendor_paths')
          .select('company, category, url, email, notes, priority, last_verified')
          .ilike('company', company.trim())
          .order('priority', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(5);
        if (!vp.error && vp.data) out.vendor = vp.data;
      }
    } catch (_) { /* ignore if table doesn't exist */ }

    // Public people via SerpAPI (Google results)
    const SERPAPI_KEY = process.env.SERPAPI_KEY;
    if (!SERPAPI_KEY) {
      return res.json({ ...out, note: "SERPAPI_KEY missing; add it in Render → Environment." });
    }

    const q = `site:linkedin.com/in "${company}" ${roleQuery || 'transportation OR logistics OR sourcing'}`;
    const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=10&api_key=${SERPAPI_KEY}`;

    const r = await fetch(url);
    if (r.ok) {
      const data = await r.json();
      const items = (data.organic_results || []).slice(0, 10);
      out.people = items
        .filter(i => /linkedin\.com\/in\//i.test(i.link || i.url))
        .map(i => ({
          name_or_title: i.title,
          url: i.link || i.url,
          snippet: i.snippet || ""
        }));
    } else {
      out.error = `SerpAPI HTTP ${r.status}`;
    }

    return res.json(out);
  } catch (e) {
    console.error('people finder error:', e);
    return res.status(500).json({ error: 'Lookup failed' });
  }
});


    if (error) throw error;
    res.json({ source: table, cards: data || [] });
  } catch (e) {
    console.error("Supabase error:", e.message || e);
    res.status(500).json({ error: "Supabase query failed" });
  }
});

// ----- Coach (OpenAI) -----
// ===== REPLACE your entire /api/coach route with this ONE block =====
// ===== REPLACE your entire /api/coach route with this block =====
// ===== REPLACE everything from app.post("/api/coach"... to its closing }); with this =====
app.post("/api/coach", async (req, res) => {
  try {
    const { prompt, userEmail } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const org = (userEmail && userEmail.split("@")[1] || "").toLowerCase();
    const isShipWMT = org === "shipwmt.com";
    const q = (prompt || "").trim();

    // ---- 1) KB retrieval with ShipWMT emphasis ----
    async function fetchNotes(topic, limit = 6) {
      if (!supabase) return [];
      const { data, error } = await supabase
        .from('kb_notes')
        .select('topic, content, created_at')
        .eq('topic', topic)
        .or(`content.ilike.%${q}%`)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error || !data) return [];
      return data;
    }

    const shipwmtMatches = await fetchNotes('ShipWMT Coaching', 6);
    const industryMatches = await fetchNotes('Industry Insights', 6);

    let shipwmtFallback = [];
    if (shipwmtMatches.length === 0 && supabase) {
      const { data } = await supabase
        .from('kb_notes')
        .select('topic, content, created_at')
        .eq('topic', 'ShipWMT Coaching')
        .order('created_at', { ascending: false })
        .limit(2);
      shipwmtFallback = data || [];
    }

    const blended = [
      ...shipwmtMatches.slice(0, 4),
      ...shipwmtFallback.slice(0, Math.max(0, 4 - shipwmtMatches.length)),
      ...industryMatches.slice(0, 2)
    ].filter(Boolean);

    // ---- 2) People Finder via SerpAPI (uses Node 22 global fetch) ----
    let peopleBlock = "";
    try {
      const m = q.match(/who should i (?:reach out to|contact)[^@]* at ([\w .,&\-()]+)\??/i)
              || q.match(/contacts? (?:at|for) ([\w .,&\-()]+)\??/i);
      const SERPAPI_KEY = process.env.SERPAPI_KEY;

      if (m && m[1] && SERPAPI_KEY) {
        const company = m[1].trim();
        const roleQuery = '("transportation" OR "logistics") (sourcing OR procurement OR carrier OR delivery OR supply chain) manager';
        const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(`site:linkedin.com/in "${company}" ${roleQuery}`)}&num=10&api_key=${SERPAPI_KEY}`;
        const r = await fetch(url);
        if (r.ok) {
          const data = await r.json();
          const items = (data.organic_results || []).slice(0, 10);
          const people = items
            .filter(i => /linkedin\.com\/in\//i.test(i.link || i.url))
            .map(i => `- ${i.title} — ${i.link || i.url}`);
          if (people.length) {
            peopleBlock = `\nPeople finder for "${company}":\nPublic profiles (names/titles):\n${people.join('\n')}\n`;
          }
        }
      }
    } catch (_) { /* ignore people errors so coach still replies */ }

    const contextBlock = (blended.length
      ? `Context snippets (prioritized: ShipWMT Coaching):\n` +
        blended.map((n,i)=>`[${i+1}] (${n.topic}) ${n.content}`).join('\n---\n')
      : `No KB matches found; prefer ShipWMT Coaching guidance and approved sources.`)
      + (peopleBlock ? `\n---\n${peopleBlock}` : "");

    const approvedSources = [
      "Internal SOPs/KB (ShipWMT Coaching)",
      "Sales creators: Darren McKee, Jacob Karp, Will Jenkins, Stephen Mathis, Kevin Dorsey",
      "Industry experts: Craig Fuller, Chris Pickett, Brittain Ladd, Brad Jacobs, Eric Williams, Ken Adamo",
      "Companies/outlets: FreightWaves/SONAR, DAT, RXO, FedEx, UPS, Walmart (and similar reputable sources)"
    ].join("; ");

    const shipwmtFocus = isShipWMT
      ? `Primary audience: employees of ShipWMT (shipwmt.com). Emphasize disciplined prospecting, one-lane trials with explicit success criteria, proactive track-and-trace, carrier vetting & scorecards, margin protection, clear escalation, and data-backed context (DAT, SONAR).`
      : `Primary audience: internal brokerage team. Emphasize ShipWMT Coaching where applicable.`;

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
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 500
    });

    return res.json({ reply: completion.choices?.[0]?.message?.content || "No reply" });

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
    console.error("OpenAI error:", e.status || "", e.message || "", e.response?.data || e);
    return res.status(500).json({ error: "OpenAI call failed", detail: e.message || "unknown error" });
  }
});

    return res.json({ reply: completion.choices?.[0]?.message?.content || "No reply" });

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
    console.error("OpenAI error:", e.status || "", e.message || "", e.response?.data || e);
    return res.status(500).json({ error: "OpenAI call failed", detail: e.message || "unknown error" });
  }
});

    // get matches by topic
    const shipwmtMatches = await fetchNotes('ShipWMT Coaching', 6);
    const industryMatches = await fetchNotes('Industry Insights', 6);

    // ensure ShipWMT flavor is always present
    let shipwmtFallback = [];
    if (shipwmtMatches.length === 0 && supabase) {
      const { data } = await supabase
        .from('kb_notes')
        .select('topic, content, created_at')
        .eq('topic', 'ShipWMT Coaching')
        .order('created_at', { ascending: false })
        .limit(2);
      shipwmtFallback = data || [];
    }

    // blend with ShipWMT emphasis
    const blended = [
      ...shipwmtMatches.slice(0, 4),
      ...shipwmtFallback.slice(0, Math.max(0, 4 - shipwmtMatches.length)),
      ...industryMatches.slice(0, 2)
    ].filter(Boolean);

    const contextBlock = blended.length
      ? `Context snippets (prioritized: ShipWMT Coaching):\n` +
        blended.map((n,i)=>`[${i+1}] (${n.topic}) ${n.content}`).join('\n---\n')
      : `No KB matches found; prefer ShipWMT Coaching guidance and approved sources.`;

    const approvedSources = [
      "Internal SOPs/KB (ShipWMT Coaching)",
      "Sales creators: Darren McKee, Jacob Karp, Will Jenkins, Stephen Mathis, Kevin Dorsey",
      "Industry experts: Craig Fuller, Chris Pickett, Brittain Ladd, Brad Jacobs, Eric Williams, Ken Adamo",
      "Companies/outlets: FreightWaves/SONAR, DAT, RXO, FedEx, UPS, Walmart (and similar reputable sources)"
    ].join("; ");

    const shipwmtFocus = isShipWMT
      ? `Primary audience: employees of ShipWMT (shipwmt.com). Emphasize disciplined prospecting, one-lane trials with explicit success criteria, proactive track-and-trace, carrier vetting & scorecards, margin protection, clear escalation, and data-backed context (DAT, SONAR).`
      : `Primary audience: internal brokerage team. Emphasize ShipWMT Coaching where applicable.`;

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
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 500
    });

    return res.json({ reply: completion.choices?.[0]?.message?.content || "No reply" });

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
    console.error("OpenAI error:", e.status || "", e.message || "", e.response?.data || e);
    return res.status(500).json({ error: "OpenAI call failed", detail: e.message || "unknown error" });
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
