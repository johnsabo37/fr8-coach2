// server.js
import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// --- Supabase client ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// --- OpenAI client ---
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// --- Health check ---
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// --- Sales cards (example from Supabase table) ---
app.get("/api/sales-cards", async (req, res) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase.from("sales_cards").select("*");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Ops cards (example from Supabase table) ---
app.get("/api/ops-cards", async (req, res) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase.from("ops_cards").select("*");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ----- Coach (OpenAI) -----
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

    const blended = [
      ...primaryMatches.slice(0, 4),
      ...industryMatches.slice(0, 2)
    ].filter(Boolean);

    // ---- 2) People Finder via SerpAPI ----
    const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
    let peopleBlock = "";
    try {
      function cleanCompany(raw) {
        if (!raw) return "";
        let c = raw.trim();
        c = c.replace(/[?.,;:]+$/g, "");
        if (/^home\s*depot$/i.test(c)) c = "The Home Depot";
        return c.trim();
      }

      let company = null;
      const m1 =
        q.match(/who should i (?:reach out to|contact)[^@]* at ([\w .,&\-()]+)\??/i);
      if (m1 && m1[1]) company = cleanCompany(m1[1]);

      if (!SERPAPI_KEY) {
        peopleBlock = `\n[People finder disabled: missing SERPAPI_KEY]\n`;
      } else if (!company) {
        peopleBlock = `\n[People finder: no company detected]\n`;
      } else {
        const roleQuery =
          '("transportation" OR "logistics") (sourcing OR procurement OR carrier OR "supply chain") manager';
        const query = `site:linkedin.com/in "${company}" ${roleQuery}`;
        const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=10&api_key=${SERPAPI_KEY}`;
        const r = await fetch(url);
        let people = [];
        if (r.ok) {
          const d = await r.json();
          const it = (d.organic_results || []).slice(0, 10);
          people = it.filter(i => /linkedin\.com\/in\//i.test(i.link || i.url))
                     .map(i => `- ${i.title} — ${i.link || i.url}`);
        }
        peopleBlock = people.length
          ? `\nPeople finder for "${company}":\n${people.join("\n")}\n`
          : `\n[People finder: 0 public LinkedIn results for "${company}"]\n`;
      }
    } catch (e2) {
      peopleBlock = `\n[People finder error: ${e2?.message || "unknown"}]\n`;
    }

    // ---- System message ----
    const systemMsg = `You are Fr8Coach, an expert freight brokerage coach.
Primary audience: ${ORG_LABEL} (${ORG_DOMAIN})
Style: concise checklists, scripts, next steps.

Context:
${blended.map((n,i)=>`[${i+1}] ${n.topic}: ${n.content}`).join("\n---\n") || "No KB matches"}
${peopleBlock}
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

    const modelText = completion.choices?.[0]?.message?.content || "No reply";
    const finalReply = (peopleBlock ? `Contacts:\n${peopleBlock}\n` : "") + modelText;
    return res.json({ reply: finalReply });

  } catch (e) {
    console.error("Coach error:", e);
    return res.status(500).json({ error: e.message });
  }
});

// --- Serve frontend ---
app.use(express.static("public"));

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
