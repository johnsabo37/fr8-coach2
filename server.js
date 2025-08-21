// server.js (CommonJS, Render-ready, cards + email-aware coach + people finder)

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
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";

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

// ----- Coach (OpenAI) -----
// Collects userEmail from body, maps to org label (for KB topic), blends KB, runs People Finder, and always prints contacts on top.
app.post("/api/coach", async (req, res) => {
  try {
    const { prompt, userEmail } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    // === Domain → Org mapping (edit/extend as you like) ===
    const ORG_MAP = {
      "shipwmt.com":    { label: "ShipWMT" },
      "ntgfreight.com": { label: "NTG" },
      "rxo.com":        { label: "RXO" },
      "fedex.com":      { label: "FedEx" },
      "ups.com":        { label: "UPS" },
      "walmart.com":    { label: "Walmart" }
    };

    const domain = (userEmail && userEmail.split("@")[1] || "").toLowerCase();
    const orgCfg = ORG_MAP[domain] || null;
    const ORG_LABEL  = orgCfg?.label || "ShipWMT";
    const ORG_DOMAIN = domain || "shipwmt.com";
    const isOrg      = !!orgCfg;

    const q = (prompt || "").trim();

    // ---- 1) KB retrieval with org emphasis ----
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

    const primaryTopic     = `${ORG_LABEL} Coaching`;
    const primaryMatches   = await fetchNotes(primaryTopic, 6);
    const industryMatches  = await fetchNotes("Industry Insights", 6);

    let primaryFallback = [];
    if (primaryMatches.length === 0 && supabase) {
      const { data } = await supabase
        .from("kb_notes")
        .select("topic, content, created_at")
        .eq("topic", primaryTopic)
        .order("created_at", { ascending: false })
        .limit(2);
      primaryFallback = data || [];
    }

    const blended = [
      ...primaryMatches.slice(0, 4),
      ...primaryFallback.slice(0, Math.max(0, 4 - primaryMatches.length)),
      ...industryMatches.slice(0, 2)
    ].filter(Boolean);

    // ---- 2) People Finder via SerpAPI (forgiving + diagnostics + company cleanup) ----
    let peopleBlock = "";
    try {
      function cleanCompany(raw) {
        if (!raw) return "";
        let c = raw.trim();
        c = c.replace(/[?.,;:]+$/g, "");
        const STOPS = [" to ", " for ", " about ", " regarding ", " re ", " in ", " on "];
        for (const s of STOPS) {
          const idx = c.toLowerCase().indexOf(s.trim());
          if (idx > 0) {
            const re = new RegExp(`\\s${s.trim()}\\s`, "i");
            c = c.split(re)[0];
            break;
          }
        }
        if (/^home\s*depot$/i.test(c)) c = "The Home Depot";
        if (/^walmart$/i.test(c))     c = "Walmart";
        if (/^ups$/i.test(c))         c = "UPS";
        if (/^fedex$/i.test(c))       c = "FedEx";
        return c.trim();
      }

      let company = null;
      const m1 =
        q.match(/who should i (?:reach out to|contact)[^@]* at ([\w .,&\-()]+)\??/i) ||
        q.match(/contacts? (?:at|for) ([\w .,&\-()]+)\??/i);
      const m2 = !m1 && q.match(/\bat\s+([A-Za-z][\w .,&\-()]+)\b/);

      if (m1 && m1[1]) company = cleanCompany(m1[1]);
      else if (m2 && m2[1]) company = cleanCompany(m2[1]);

      if (!SERPAPI_KEY) {
        peopleBlock = `\n[People finder disabled: missing SERPAPI_KEY in server env]\n`;
      } else if (!company) {
        peopleBlock = `\n[People finder: no company detected. Try "Who should I reach out to at <Company>..."]\n`;
      } else {
        const roleQuery =
          '("transportation" OR "logistics") (sourcing OR procurement OR carrier OR delivery OR "supply chain") manager';

        // primary query
        const q1 = `site:linkedin.com/in "${company}" ${roleQuery}`;
        const url1 = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q1)}&num=10&api_key=${SERPAPI_KEY}`;
        const r1 = await fetch(url1);

        let people = [];
        if (r1.ok) {
          const d1 = await r1.json();
          const items1 = (d1.organic_results || []).slice(0, 10);
          people = items1
            .filter(i => /linkedin\.com\/in\//i.test(i.link || i.url))
            .map(i => `- ${i.title} — ${i.link || i.url}`);
        }

        // fallback without leading "The "
        if (people.length === 0) {
          const altCo = company.replace(/^The\s+/i, "");
          const q2 = `site:linkedin.com/in "${altCo}" ${roleQuery}`;
          const url2 = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q2)}&num=10&api_key=${SERPAPI_KEY}`;
          const r2 = await fetch(url2);
          if (r2.ok) {
            const d2 = await r2.json();
            const items2 = (d2.organic_results || []).slice(0, 10);
            people = items2
              .filter(i => /linkedin\.com\/in\//i.test(i.link || i.url))
              .map(i => `- ${i.title} — ${i.link || i.url}`);
          }
        }

        peopleBlock = people.length
          ? `\nPeople finder for "${company}":\nPublic profiles (names/titles):\n${people.join("\n")}\n`
          : `\n[People finder: 0 public LinkedIn results for "${company}" with that role query]\n`;
      }
    } catch (e2) {
      peopleBlock = `\n[People finder error: ${e2?.message || "unknown"}]\n`;
    }

    // ---- System message with org focus ----
    const approvedSources = [
      `Internal SOPs/KB (${ORG_LABEL} Coaching)`,
      "Sales creators: Darren McKee, Jacob Karp, Will Jenkins, Stephen Mathis, Kevin Dorsey",
      "Industry experts: Craig Fuller, Chris Pickett, Brittain Ladd, Brad Jacobs, Eric Williams, Ken Adamo",
      "Companies/outlets: FreightWaves/SONAR, DAT, RXO, FedEx, UPS, Walmart (and similar reputable sources)"
    ].join("; ");

    const orgFocus = isOrg
      ? `Primary audience: employees of ${ORG_LABEL} (${ORG_DOMAIN}). Emphasize disciplined prospecting, one-lane trials with explicit success criteria, proactive track-and-trace, carrier vetting & scorecards, margin protection, clear escalation, and data-backed context (DAT, SONAR).`
      : `Primary audience: internal brokerage team. Emphasize ${ORG_LABEL} Coaching where applicable.`;

    const contextBlock =
      (blended.length
        ? `Context snippets (prioritized: ${ORG_LABEL} Coaching):\n` +
          blended.map((n, i) => `[${i + 1}] (${n.topic}) ${n.content}`).join("\n---\n")
        : `No KB matches found; prefer ${ORG_LABEL} Coaching guidance and approved sources.`) +
      (peopleBlock ? `\n---\n${peopleBlock}` : "");

    const systemMsg = `You are Fr8Coach, an expert freight brokerage coach for an internal team.
${orgFocus}
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

    // Always surface People Finder section
    const modelText = completion.choices?.[0]?.message?.content || "No reply";
    const finalReply = (peopleBlock ? `Contacts & intake:\n${peopleBlock}\n` : "") + modelText;
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

// ----- Frontend fallback -----
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ----- Start server -----
app.listen(PORT, () => {
  console.log(`Fr8Coach running on port ${PORT}`);
});
