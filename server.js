// server.js — FULL, CLEAN VERSION with separate ADMIN_PASSWORD for /api/admin/*

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

// ----- Env -----
const PORT = process.env.PORT || 10000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ""; // <-- separate admin secret
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SERPAPI_KEY = process.env.SERPAPI_KEY || ""; // optional
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small"; // 1536-dim

// ----- App -----
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Health
app.get("/api/ping", (req, res) => res.json({ ok: true, message: "pong" }));

// Gate all regular /api routes with the SITE_PASSWORD
app.use("/api", (req, res, next) => {
  if (req.path === "/ping") return next();

  // Allow admin routes to be handled by their own middleware (below).
  if (req.path.startsWith("/admin/")) return next();

  if (req.headers["x-site-password"] !== SITE_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ===== Helpers =====
function chunkText(text, maxLen = 2000, overlap = 200, maxChunks = 50) {
  const t = String(text || "");
  const chunks = [];
  let start = 0;
  while (start < t.length && chunks.length < maxChunks) {
    const end = Math.min(start + maxLen, t.length);
    const slice = t.slice(start, end).trim();
    if (slice.length > 120) chunks.push(slice);
    start = end - overlap;
    if (start < 0) start = 0;
  }
  return chunks;
}
async function embedOne(text) {
  if (!openai) throw new Error("OpenAI not configured");
  const r = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text });
  return r.data[0].embedding;
}

// ----- Cards (sales/ops) -----
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

// ----- KB hybrid search API -----
// POST /api/kb/search { q, limit? }
app.post("/api/kb/search", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
    if (!openai)   return res.status(500).json({ error: "OpenAI not configured" });
    const { q, limit = 8 } = req.body || {};
    if (!q || !q.trim()) return res.status(400).json({ error: "Missing q" });

    const emb = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: q });
    const queryEmbedding = emb.data?.[0]?.embedding;
    const { data, error } = await supabase.rpc("kb_hybrid_search", {
      query_embedding: queryEmbedding,
      query_text: q,
      limit_n: limit,
      w_vec: 0.6,
      w_kw: 0.4
    });
    if (error) throw error;
    res.json({ results: data || [] });
  } catch (e) {
    console.error("kb/search error:", e.message || e);
    res.status(500).json({ error: "KB search failed" });
  }
});

// ----- People Finder helpers (optional SerpAPI) -----
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
  let company = detectCompanyFromText(prompt);
  if (company) return company;
  const items = Array.isArray(history) ? history.slice().reverse() : [];
  for (const m of items) {
    if (!m || !m.content) continue;
    if (m.role !== "assistant") {
      const c = detectCompanyFromText(m.content);
      if (c) return c;
    }
  }
  for (const m of items) {
    if (!m || !m.content) continue;
    const c = detectCompanyFromText(m.content);
    if (c) return c;
  }
  return null;
}

// ----- Coach (KB + optional People Finder) -----
app.post("/api/coach", async (req, res) => {
  try {
    const { prompt, history } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });
    const q = (prompt || "").trim();
    if (!openai) return res.status(500).json({ error: "OpenAI not configured" });

    // 1) KB retrieval
    let kbResults = [];
    try {
      const emb = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: q });
      const queryEmbedding = emb.data?.[0]?.embedding;
      if (queryEmbedding && supabase) {
        const { data } = await supabase.rpc("kb_hybrid_search", {
          query_embedding: queryEmbedding,
          query_text: q,
          limit_n: 8,
          w_vec: 0.6,
          w_kw: 0.4
        });
        kbResults = data || [];
      }
    } catch (_) {}

    const citations = kbResults.map((r, i) => {
      const label = `[${i+1}] ${r.title || 'Doc'} (score: ${r.score?.toFixed(2) || '-'})`;
      const link  = r.source_url ? ` — ${r.source_url}` : '';
      const snippet = (r.text || '').slice(0, 320).replace(/\s+/g,' ').trim();
      return `${label}${link}\n${snippet}…`;
    }).join('\n---\n');

    // 2) People finder (optional)
    let peopleBlock = "";
    try {
      const company = detectCompany(prompt, history);
      if (SERPAPI_KEY && company && global.fetch) {
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
          if (alt && alt !== company) people = await querySerp(alt);
        }
        if (people.length) {
          peopleBlock = `\nContacts & intake — ${company}:\n${people.join("\n")}\n\n`;
        }
      }
    } catch (_) {}

    const approvedSources = [
      "Internal SOPs/KB (Windmill Transport coaching)",
      "Sales creators: Darren McKee, Jacob Karp, Will Jenkins, Stephen Mathis, Kevin Dorsey",
      "Industry experts: Craig Fuller, Chris Pickett, Brittain Ladd, Brad Jacobs, Eric Williams, Ken Adamo",
      "Companies/outlets: FreightWaves/SONAR, DAT, RXO, FedEx, UPS, Walmart"
    ].join("; ");

    const contextBlock =
      (citations ? `Context snippets (KB search):\n${citations}` :
        `No KB matches found; prefer Windmill Transport coaching guidance and approved sources.`) +
      (peopleBlock ? `\n---\n${peopleBlock}` : "");

    const systemMsg = `You are Fr8Coach, an expert freight brokerage coach for employees of Windmill Transport (shipwmt.com).
Emphasize: disciplined prospecting & sequencing, one-lane trials with explicit success criteria, proactive track-and-trace, carrier vetting & scorecards, margin protection, clear escalation/SOPs, and data-backed context (DAT, SONAR).
Approved sources (priority): ${approvedSources}
Style: concise checklists, concrete scripts, measurable next steps.
Cite snippets like [1], [2] that correspond to the context block.

${contextBlock}
`;

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
      max_tokens: 800
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

// ===== Admin Upload API — now requires x-admin-password header =====
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }); // 2MB/file
app.post("/api/admin/upload", upload.array("files", 10), async (req, res) => {
  try {
    // Check separate admin password
    if (req.headers["x-admin-password"] !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Unauthorized (admin)" });
    }
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
    if (!openai)   return res.status(500).json({ error: "OpenAI not configured" });

    const {
      title,
      source_type = "SOP",
      source_url = null,
      vertical = "General",
      shipper = "Windmill Transport",
      tags = ""
    } = req.body || {};

    const tagList = String(tags || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files uploaded" });

    const results = [];

    for (const file of files) {
      const mime = (file.mimetype || "").toLowerCase();
      const allowed = ["text/plain", "text/markdown", "application/octet-stream"];
      if (!allowed.includes(mime)) {
        results.push({ filename: file.originalname, status: "skipped", reason: `Unsupported type: ${mime}` });
        continue;
      }

      const raw = file.buffer.toString("utf8");
      const docTitle = (title && title.trim()) || file.originalname;

      const { data: docRow, error: docErr } = await supabase
        .from("kb_docs")
        .insert({
          title: docTitle,
          source_type,
          source_url,
          vertical,
          shipper,
          tags: tagList.length ? tagList : null
        })
        .select("id")
        .single();
      if (docErr) throw docErr;
      const doc_id = docRow.id;

      const chunks = chunkText(raw);
      let idx = 0;
      for (const chunk of chunks) {
        const emb = await embedOne(chunk);
        const { error: chErr } = await supabase
          .from("kb_chunks")
          .insert({ doc_id, chunk_index: idx, text: chunk, embedding: emb });
        if (chErr) throw chErr;
        idx += 1;
      }

      results.push({ filename: file.originalname, status: "ok", chunks: chunks.length });
    }

    res.json({ ok: true, results });
  } catch (e) {
    console.error("Admin upload error:", e);
    res.status(500).json({ error: "Upload failed", detail: e.message || "unknown error" });
  }
});

// ----- Static routes -----
app.get("/sales.html", (_req, res) => res.sendFile(path.join(__dirname, "public", "sales.html")));
app.get("/ops.html", (_req, res) => res.sendFile(path.join(__dirname, "public", "ops.html")));
app.get("/sales", (_req, res) => res.sendFile(path.join(__dirname, "public", "sales.html")));
app.get("/ops", (_req, res) => res.sendFile(path.join(__dirname, "public", "ops.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`Fr8Coach running on port ${PORT}`);
});
