// server.js — FULL VERSION: admin auth helpers + ping + bulk "Leads" ingestion +
// smarter People Finder that works after a "leads" reply or when asked to include contacts
// (expanded matcher: executives, buyers, procurement leads, shipping/transportation managers, etc.)

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
const SITE_USER = process.env.SITE_USER || "user";        // Basic Auth username
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";    // Basic Auth password
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";  // separate admin secret
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SERPAPI_KEY = process.env.SERPAPI_KEY || ""; // optional for contacts
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small"; // 1536-dim

// ===== App =====
const app = express();

/** ------------------------------------------------------------------
 *  Browser popup (Basic Auth) BEFORE everything else.
 *  Uses SITE_USER / SITE_PASSWORD.
 *  If SITE_PASSWORD is empty, this layer is skipped.
 * ------------------------------------------------------------------ */
app.use((req, res, next) => {
  if (!SITE_PASSWORD) return next(); // skip if not configured
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="fr8coach"');
    return res.status(401).send("Authentication required.");
  }
  try {
    const decoded = Buffer.from(auth.split(" ")[1], "base64").toString("utf8"); // "user:pass"
    const i = decoded.indexOf(":");
    const user = i >= 0 ? decoded.slice(0, i) : "";
    const pass = i >= 0 ? decoded.slice(i + 1) : "";
    if (user === SITE_USER && pass === SITE_PASSWORD) return next();
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

// Health
app.get("/api/ping", (_req, res) => res.json({ ok: true, message: "pong" }));

/** ------------------------------------------------------------------
 *  IMPORTANT CHANGE:
 *  We REMOVED the old /api header gate that required 'x-site-password'.
 *  With Basic Auth now protecting the whole site, the APIs should not
 *  return 401 for normal users. This prevents your page from showing
 *  its in-page password modal.
 * ------------------------------------------------------------------ */
// (No app.use("/api", ...) password check anymore)

// ===== Admin AUTH helpers =====
function normalizeSecret(s) {
  if (typeof s !== "string") return "";
  const unquoted = s.replace(/^["']|["']$/g, "");
  return unquoted.normalize("NFKC").trim();
}
const ADMIN_SECRET = normalizeSecret(ADMIN_PASSWORD || "");
if (!ADMIN_SECRET) {
  console.warn("[AdminAuth] ADMIN_PASSWORD is EMPTY or not set.");
} else {
  console.log(`[AdminAuth] ADMIN_PASSWORD is configured (len=${ADMIN_SECRET.length}).`);
}
function timingSafeEqualAtoB(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function isAdminAuthorized(req) {
  const hdr = normalizeSecret(req.headers["x-admin-password"] || "");
  if (!ADMIN_SECRET || !hdr) return false;
  return timingSafeEqualAtoB(hdr, ADMIN_SECRET);
}

// Quick admin ping endpoint (to test password without uploading files)
app.get("/api/admin/ping", (req, res) => {
  if (!isAdminAuthorized(req)) return res.status(401).json({ ok: false, error: "Unauthorized (admin)" });
  return res.json({ ok: true, admin: true });
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
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function isLeadsRequest(q = "") {
  const s = q.toLowerCase();
  return /\bleads?\b/.test(s) || /prospect lists?/.test(s) || /give me .*companies?/.test(s);
}

// >>> Expanded contact-intent matcher <<<
function wantsContacts(q = "") {
  const s = q.toLowerCase();

  const patterns = [
    /\bcontacts?\b/,
    /\bcontact info\b/,
    /\bdecision makers?\b/,
    /\bkey people\b/,
    /\bwho (to|should i) (reach out|contact)\b/,

    // Additional terms you requested:
    /\bexecutives?\b/,
    /\bbuyers?\b/,
    /\bprocurement leads?\b/,
    /\bprocurement (?:manager|director|head)s?\b/,
    /\bsupply chain (?:lead|leader|head|manager|director)s?\b/,
    /\bshipping managers?\b/,
    /\btransportation managers?\b/,

    // extra useful variants
    /\blogistics (?:manager|director|head)s?\b/,
    /\bcarrier (?:manager|relations|procurement)\b/,
    /\bvender|vendor (?:manager|relations)\b/
  ];

  return patterns.some(re => re.test(s));
}

async function getRandomLeadCompanies(limit = 10) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("kb_docs")
    .select("shipper")
    .eq("source_type", "Leads")
    .not("shipper", "is", null)
    .limit(2000);
  if (error || !data) return [];
  const names = data.map(r => (r.shipper || "").trim()).filter(Boolean);
  const unique = Array.from(new Set(names));
  shuffleInPlace(unique);
  return unique.slice(0, limit);
}

// ===== People Finder helpers (SERPAPI) =====
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

// Extract company list from the previous assistant leads reply
function extractLeadsFromHistory(history) {
  if (!Array.isArray(history) || !history.length) return [];
  const lastAssistant = [...history].reverse().find(m => m.role === "assistant" && typeof m.content === "string");
  if (!lastAssistant) return [];
  const lines = lastAssistant.content.split(/\r?\n/);
  const results = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:-|\d+[.)])\s*["“]?([^"”]+?)["”]?\s*$/);
    if (m && m[1]) {
      const name = m[1].trim();
      if (name && !/next steps/i.test(name)) results.push(name);
    }
  }
  return results;
}

// Query SerpAPI for up to N contacts at a company
async function findContactsForCompany(companyName, max = 3) {
  if (!SERPAPI_KEY || !companyName) return [];
  const roleQuery =
    '("transportation" OR "logistics" OR "shipping" OR "supply chain") (sourcing OR procurement OR buyer OR carrier OR delivery OR "supply chain" OR manager OR director OR head)';
  const q1 = `site:linkedin.com/in "${companyName}" ${roleQuery}`;
  const url1 = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q1)}&num=${max}&api_key=${SERPAPI_KEY}`;
  const r1 = await fetch(url1);
  if (!r1.ok) return [];
  const d1 = await r1.json();
  const items1 = (d1.organic_results || []).slice(0, max);
  return items1
    .filter(i => /linkedin\.com\/in\//i.test(i.link || i.url))
    .map(i => {
      const title = (i.title || "").replace(/\s+-\s*LinkedIn\s*$/i, "").trim();
      const link = i.link || i.url || "";
      return { title, link };
    });
}

// ===== Cards (sales/ops) =====
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

// ===== KB hybrid search API =====
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

// ===== Coach (handles Leads + People Finder follow-ups) =====
app.post("/api/coach", async (req, res) => {
  try {
    const { prompt, history } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });
    const q = (prompt || "").trim();
    if (!openai) return res.status(500).json({ error: "OpenAI not configured" });

    // A) Leads ask — possibly "include contact info"
    if (isLeadsRequest(q)) {
      const leads = await getRandomLeadCompanies(10);
      if (!leads.length) {
        return res.json({
          reply: `No leads found yet. To add leads: go to /admin, choose Source Type “Leads”, and upload a .txt file with ONE COMPANY PER LINE.`
        });
      }
      const list = leads.map((c, i) => `${i + 1}. ${c}`).join("\n");

      // If user also asked for contacts/decision makers, pull a few per company
      if (wantsContacts(q)) {
        if (!SERPAPI_KEY) {
          return res.json({
            reply:
`Here are 10 leads from your library:

${list}

To include contact profiles automatically, add a SERPAPI_KEY in Render → Environment (then redeploy).`
          });
        }
        const MAX_COMPANIES = 5; // limit to keep it readable + avoid rate overuse
        const MAX_CONTACTS_PER = 2;
        const companiesForContacts = leads.slice(0, MAX_COMPANIES);
        let out = `Here are 10 leads from your library:\n\n${list}\n\nKey decision makers / contacts (top ${MAX_COMPANIES} companies):\n`;
        for (const name of companiesForContacts) {
          const contacts = await findContactsForCompany(name, MAX_CONTACTS_PER);
          if (contacts.length) {
            out += `\n• ${name}\n` + contacts.map(c => `  - ${c.title} — ${c.link}`).join("\n");
          } else {
            out += `\n• ${name}\n  - (No public profiles found in top results)`;
          }
        }
        out += `\n\nNext steps:\n- Pick 3–5 for one-lane trial outreach.\n- Use your retail prospecting sequence and book time to review outcomes.`;
        return res.json({ reply: out });
      }

      // Default: leads only
      return res.json({
        reply:
`Here are 10 leads from your library:

${list}

Next steps:
- Pick 3–5 for a one-lane trial outreach.
- Use your retail prospecting sequence and book time to review outcomes.`
      });
    }

    // B) Follow-up "contacts / key decision makers / contact info / executives / shipping manager" after a leads reply
    if (wantsContacts(q)) {
      // 1) If a specific company is detected (current prompt/history), use that
      const explicitCompany = detectCompany(prompt, history);
      if (explicitCompany) {
        if (!SERPAPI_KEY) {
          return res.json({ reply: `I can pull public profiles once a SERPAPI_KEY is set in Render → Environment (then redeploy).` });
        }
        const contacts = await findContactsForCompany(explicitCompany, 5);
        if (!contacts.length) {
          return res.json({ reply: `No public profiles found for "${explicitCompany}" in top results. Try specifying the exact division or city.` });
        }
        const block = contacts.map(c => `- ${c.title} — ${c.link}`).join("\n");
        return res.json({ reply: `Contacts & intake — ${explicitCompany}:\n${block}` });
      }

      // 2) Otherwise, try to pull the company list from the most recent assistant leads reply
      const fromHistory = extractLeadsFromHistory(history).slice(0, 5);
      if (fromHistory.length) {
        if (!SERPAPI_KEY) {
          return res.json({ reply: `I can pull contact profiles for your recent leads once a SERPAPI_KEY is set in Render → Environment.` });
        }
        const MAX_CONTACTS_PER = 2;
        let out = `Contacts / decision makers from your latest leads list:\n`;
        for (const name of fromHistory) {
          const contacts = await findContactsForCompany(name, MAX_CONTACTS_PER);
          if (contacts.length) {
            out += `\n• ${name}\n` + contacts.map(c => `  - ${c.title} — ${c.link}`).join("\n");
          } else {
            out += `\n• ${name}\n  - (No public profiles found in top results)`;
          }
        }
        return res.json({ reply: out });
      }
      // 3) No explicit company and no leads in history → generic guidance fallback
    }

    // ===== KB retrieval (normal coaching) =====
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

    const approvedSources = [
      "Internal SOPs/KB (Windmill Transport coaching)",
      "Sales creators: Darren McKee, Jacob Karp, Will Jenkins, Stephen Mathis, Kevin Dorsey",
      "Industry experts: Craig Fuller, Chris Pickett, Brittain Ladd, Brad Jacobs, Eric Williams, Ken Adamo",
      "Companies/outlets: FreightWaves/SONAR, DAT, RXO, FedEx, UPS, Walmart"
    ].join("; ");

    const contextBlock =
      (citations ? `Context snippets (KB search):\n${citations}` :
        `No KB matches found; prefer Windmill Transport coaching guidance and approved sources.`);

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
    return res.json({ reply: modelText });
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

// ===== Admin Upload API — with bulk "Leads" ingestion =====
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }); // 2MB/file
app.post("/api/admin/upload", upload.array("files", 10), async (req, res) => {
  try {
    if (!isAdminAuthorized(req)) {
      return res.status(401).json({ error: "Unauthorized (admin)" });
    }
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
    // OpenAI is only needed for non-Leads embeddings; okay if absent for Leads-only uploads
    const needAI = req.body?.source_type !== "Leads";
    if (needAI && !openai)   return res.status(500).json({ error: "OpenAI not configured" });

    let {
      title,
      source_type = "SOP",
      source_url = null,
      vertical = "General",
      shipper = "Windmill Transport", // "Company"
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

      // Bulk leads ingestion (one company per line, no embeddings)
      if ((source_type || "").toLowerCase() === "leads") {
        const lines = raw
          .split(/\r?\n/)
          .map(s => s.trim())
          .filter(s => s.length > 0 && !/^\s*(#|\/\/)/.test(s));
        const unique = Array.from(new Set(lines));
        let inserted = 0;
        const mergedTags = tagList.length ? tagList : ["leads"];
        const BATCH = 100;
        for (let i = 0; i < unique.length; i += BATCH) {
          const slice = unique.slice(i, i + BATCH).map(companyName => ({
            title: title ? `${title} — ${companyName}` : `${companyName} (Lead)`,
            source_type: "Leads",
            source_url,
            vertical,
            shipper: companyName,
            tags: mergedTags
          }));
          const { error: insErr } = await supabase.from("kb_docs").insert(slice);
          if (insErr) throw insErr;
          inserted += slice.length;
        }
        results.push({ filename: file.originalname, status: "ok", leads_added: inserted });
        continue;
      }

      // Default behavior (SOP/Playbook/etc.) — create one doc + chunks + embeddings
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

// ===== Static routes =====
app.get("/sales.html", (_req, res) => res.sendFile(path.join(__dirname, "public", "sales.html")));
app.get("/ops.html", (_req, res) => res.sendFile(path.join(__dirname, "public", "ops.html")));
app.get("/sales", (_req, res) => res.sendFile(path.join(__dirname, "public", "sales.html")));
app.get("/ops", (_req, res) => res.sendFile(path.join(__dirname, "public", "ops.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`Fr8Coach running on port ${PORT}`);
});
