/**
 * OpenFS ↔ MediaWiki sync server
 *
 * Runs as a persistent background service that keeps MediaWiki and OpenFS in sync.
 * Exposes a small HTTP API so the wiki.astro playground can trigger syncs.
 *
 * Usage:
 *   bun run packages/agent-wiki-mw/src/server.ts
 *
 * Env:
 *   PORT          HTTP port (default 4322)
 *   MW_URL        MediaWiki URL (default http://localhost:8082)
 *   MW_USER       MediaWiki user (default Derek)
 *   MW_PASS       MediaWiki password
 *   SYNC_INTERVAL Poll interval in seconds (default 60)
 *   ANTHROPIC_API_KEY
 */

import { MwBot } from "./bot.js";
import { OpenFsMwSync } from "./sync.js";
import { S3KnowledgePipeline, ChromaStore } from "../../agent-knowledge/src/index.js";

const PORT          = parseInt(process.env.SYNC_PORT ?? process.env.WIKI_MW_PORT ?? "4322");
const MW_URL        = process.env.MW_URL  ?? "http://localhost:8082";
const MW_PUBLIC_URL = process.env.MW_PUBLIC_URL ?? MW_URL; // browser-accessible URL
const MW_USER       = process.env.MW_USER ?? "Derek";
const MW_PASS       = process.env.MW_PASS ?? "Yugioh4444!";
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL ?? "60") * 1000;

// ── Shared state ──────────────────────────────────────────────────────────────

let sync: OpenFsMwSync | null = null;
let bot:  MwBot | null = null;
let lastSync = 0;
let integrations: any = null;
let syncRunning = false;
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

// ── Normalize rules store ─────────────────────────────────────────────────────

/** Default system prompts, keyed by file extension (no leading dot for table key) */
const NORMALIZE_DEFAULT_PROMPTS: Record<string, string> = {
  xlsx: `You are a spreadsheet structure analyst using tidy-data principles.
Identify the real header row, where data begins, and which columns carry meaningful data.
Respond ONLY with JSON: {"header_row":<int>,"data_start_row":<int>,"col_indices":[<int>...],"notes":"<str>"}`,

  pdf: `You are a document normalizer. You receive raw PDF-extracted text which may have:
- garbled reading order from multi-column layouts
- repeated headers/footers on every page
- page numbers, watermarks, and artifacts
- broken sentences across line breaks

Clean the text into well-structured markdown:
- Use # / ## / ### for headings (infer from context/formatting)
- Preserve tables as markdown tables
- Remove page numbers, headers, footers, watermarks
- Fix broken words and sentence splits
- Do NOT summarize — keep all substantive content`,

  docx: `You are a document normalizer. You receive text extracted from a Word document.
Clean and structure it as markdown:
- Infer heading hierarchy from context (bold lines, ALL CAPS, numbering)
- Render tables as markdown tables
- Remove redundant whitespace, page breaks, field codes
- Preserve numbered lists, bullet points
- Do NOT summarize — keep all substantive content`,

  csv: `You are a document normalizer. Parse the CSV and render it as a clean markdown table with proper column headers.
Fix any encoding issues, trim whitespace, and align column types.
Do NOT summarize — keep all data rows.`,

  log: `You are a log file analyzer. Structure the log as clean markdown:
- Group entries by severity level (ERROR, WARN, INFO, DEBUG)
- Format timestamps consistently as ISO 8601
- Highlight errors and exceptions clearly
- Preserve all log lines — do NOT summarize`,

  txt: `You are a document normalizer. Structure this plain-text file as clean markdown.
Infer headings, lists, and sections from context.
Do NOT summarize — keep all substantive content.`,

  md: `You are a document normalizer. Fix and improve the formatting of this markdown file.
Ensure consistent heading hierarchy, clean lists, and proper code blocks.
Do NOT change the substantive content.`,
};

class NormalizeRulesStore {
  private db: any;

  constructor(db: any) {
    this.db = db;
    db.run(`CREATE TABLE IF NOT EXISTS normalize_rules (
      doc_type   TEXT PRIMARY KEY,
      prompt     TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  getAll(): Record<string, { prompt: string; isCustom: boolean; updatedAt?: string }> {
    const rows = this.db.query("SELECT doc_type, prompt, updated_at FROM normalize_rules").all() as any[];
    const saved = Object.fromEntries(rows.map((r: any) => [r.doc_type, { prompt: r.prompt, updatedAt: r.updated_at }]));
    const out: Record<string, { prompt: string; isCustom: boolean; updatedAt?: string }> = {};
    // Merge defaults + saved (saved wins)
    for (const [type, defaultPrompt] of Object.entries(NORMALIZE_DEFAULT_PROMPTS)) {
      if (saved[type]) {
        out[type] = { prompt: saved[type].prompt, isCustom: true, updatedAt: saved[type].updatedAt };
      } else {
        out[type] = { prompt: defaultPrompt, isCustom: false };
      }
    }
    return out;
  }

  getPrompt(docType: string): string {
    const row = this.db.query("SELECT prompt FROM normalize_rules WHERE doc_type = ?").get(docType) as any;
    return row?.prompt ?? NORMALIZE_DEFAULT_PROMPTS[docType] ?? "";
  }

  upsert(docType: string, prompt: string): void {
    this.db.run(
      `INSERT INTO normalize_rules (doc_type, prompt, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(doc_type) DO UPDATE SET prompt = excluded.prompt, updated_at = excluded.updated_at`,
      [docType, prompt, new Date().toISOString()]
    );
  }

  reset(docType: string): void {
    this.db.run("DELETE FROM normalize_rules WHERE doc_type = ?", [docType]);
  }
}

let normalizeRules: NormalizeRulesStore | null = null;

// ── Auth store ────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET ?? "openfs-default-secret-change-me";

class UsersStore {
  private db: any;

  constructor(db: any) {
    this.db = db;
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL DEFAULT '',
      role          TEXT NOT NULL DEFAULT 'employee',
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }

  async seedDefaultAdmin(): Promise<void> {
    const count = (this.db.query("SELECT COUNT(*) as n FROM users").get() as any)?.n ?? 0;
    if (count === 0) {
      await this.create("admin", "Admin", "admin", "openfs-admin");
      log("[users] Created default admin (admin / openfs-admin) — change this password!");
    }
  }

  async create(username: string, name: string, role: string, password: string): Promise<void> {
    const hash = await hashPassword(password);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    this.db.run(
      `INSERT INTO users (id, username, name, role, password_hash) VALUES (?, ?, ?, ?, ?)`,
      [id, username, name, role, hash]
    );
  }

  async verify(username: string, password: string): Promise<any | null> {
    const user = this.db.query("SELECT * FROM users WHERE username = ?").get(username) as any;
    if (!user) return null;
    const ok = await verifyPassword(password, user.password_hash);
    return ok ? { id: user.id, username: user.username, name: user.name, role: user.role } : null;
  }

  list(): any[] {
    return (this.db.query("SELECT id, username, name, role, created_at FROM users ORDER BY created_at").all() as any[]);
  }

  getById(id: string): any {
    return this.db.query("SELECT id, username, name, role, created_at FROM users WHERE id = ?").get(id);
  }

  delete(id: string): void {
    this.db.run("DELETE FROM users WHERE id = ?", [id]);
  }

  async updatePassword(id: string, password: string): Promise<void> {
    const hash = await hashPassword(password);
    this.db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, id]);
  }
}

let usersStore: UsersStore | null = null;

// ── Feedback store ────────────────────────────────────────────────────────────

class FeedbackStore {
  private db: any;

  constructor(db: any) {
    this.db = db;
    db.run(`CREATE TABLE IF NOT EXISTS portal_feedback (
      id         TEXT PRIMARY KEY,
      question   TEXT NOT NULL,
      answer     TEXT NOT NULL,
      vote       INTEGER NOT NULL,
      collection TEXT NOT NULL DEFAULT 'openfs-knowledge',
      topic      TEXT,
      user_id    TEXT,
      username   TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }

  record(data: {
    question: string; answer: string; vote: number;
    collection?: string; topic?: string; userId?: string; username?: string;
  }): void {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    this.db.run(
      `INSERT INTO portal_feedback (id, question, answer, vote, collection, topic, user_id, username)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, data.question, data.answer, data.vote, data.collection ?? "openfs-knowledge",
       data.topic ?? null, data.userId ?? null, data.username ?? null]
    );
  }

  list(limit = 100): any[] {
    return (this.db.query(
      `SELECT id, question, vote, collection, topic, username, created_at FROM portal_feedback ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as any[]);
  }

  stats(): any {
    const rows = this.db.query(`
      SELECT
        collection,
        topic,
        COUNT(*) as total,
        SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END) as thumbs_up,
        SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) as thumbs_down
      FROM portal_feedback
      GROUP BY collection, topic
      ORDER BY total DESC
    `).all() as any[];
    const overall = this.db.query(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END) as thumbs_up,
        SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) as thumbs_down
      FROM portal_feedback
    `).get() as any;
    return { overall, byCollection: rows };
  }

  topQuestions(limit = 20): any[] {
    return (this.db.query(`
      SELECT question,
        COUNT(*) as votes,
        ROUND(100.0 * SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END) / COUNT(*), 0) as score_pct
      FROM portal_feedback
      GROUP BY question
      ORDER BY votes DESC
      LIMIT ?
    `).all(limit) as any[]);
  }
}

let feedbackStore: FeedbackStore | null = null;

// ── Crypto helpers ────────────────────────────────────────────────────────────

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256);
  const hash = new Uint8Array(bits);
  const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  return `${toB64(salt)}:${toB64(hash)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [saltB64, hashB64] = stored.split(":");
    const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    const expected = Uint8Array.from(atob(hashB64), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256);
    const actual = new Uint8Array(bits);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch { return false; }
}

async function signJwt(payload: object): Promise<string> {
  const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body   = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 }));
  const sig_input = `${header}.${body}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sig_input));
  const sig64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `${sig_input}.${sig64}`;
}

async function verifyJwt(token: string): Promise<any | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(`${header}.${body}`));
    if (!valid) return null;
    const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

async function requireAuth(req: Request): Promise<any | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  return await verifyJwt(token);
}

// ── Persistent synthesis map ──────────────────────────────────────────────────
// Stored as a JSON file on the host (via volume mount) so it survives container
// restarts. Tracks which source MW titles have already been synthesized.

import { readFileSync, writeFileSync, existsSync } from "fs";

const MAP_FILE = new URL("../../.synthesis-map.json", import.meta.url).pathname;

interface MapEntry {
  openfsPath: string;   // e.g. /wiki/it-command-center.md
  synthesizedAt: string; // ISO timestamp
}

type SynthesisMap = Record<string, MapEntry>; // key = mwTitle (source page)

async function loadSynthesisMap(): Promise<SynthesisMap> {
  try {
    if (!existsSync(MAP_FILE)) return {};
    return JSON.parse(readFileSync(MAP_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveSynthesisMap(map: SynthesisMap): Promise<void> {
  writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
  log(`Synthesis map saved to ${MAP_FILE}`);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const OPENFS_DB_PATH = process.env.OPENFS_DB_PATH ?? new URL("../../openfs.db", import.meta.url).pathname;
const CHROMA_URL     = process.env.CHROMA_URL ?? "http://localhost:8000";

async function boot() {
  log(`[boot] loading openfs-wasm…`);
  const { createAgentFsFromAdapter } = await import("openfs-wasm");
  log(`[boot] loading @openfs/agent-wiki…`);
  const { AgentWiki }                = await import("@openfs/agent-wiki");
  log(`[boot] loading @openfs/adapter-sqlite…`);
  const { SqliteAdapter }            = await import("@openfs/adapter-sqlite");
  log(`[boot] imports loaded`);
  // MediaWiki login — only if MW_URL is explicitly set
  if (process.env.MW_URL) {
    log(`Attempting MW login at ${MW_URL} as ${MW_USER}…`);
    bot = new MwBot({ baseUrl: MW_URL, username: MW_USER, password: MW_PASS });
    await bot.login();
    log(`Logged in as ${MW_USER} @ ${MW_URL}`);
  } else {
    log(`MW_URL not set — running without MediaWiki sync`);
  }

  // Use native bun:sqlite for server-side persistence — data survives restarts.
  // OPENFS_DB_PATH env var controls the file location (volume-mount in Docker).
  const adapter = new SqliteAdapter({ dbPath: OPENFS_DB_PATH, walMode: true });
  log(`OpenFS DB: ${OPENFS_DB_PATH}`);

  const fs   = await createAgentFsFromAdapter(adapter, { writable: true });
  const llm  = makeLlm();
  const wiki = await AgentWiki.create(fs, llm);
  if (bot) {
    sync = new OpenFsMwSync(bot, wiki);
  }

  // Integration manager — lazy import to avoid top-level bun:sqlite at module load
  const { IntegrationManager } = await import("./integrations.js");
  const { Database }           = await import("bun:sqlite");
  const rawDb = new Database(OPENFS_DB_PATH);
  integrations = new IntegrationManager(rawDb);
  normalizeRules = new NormalizeRulesStore(rawDb);
  usersStore = new UsersStore(rawDb);
  await usersStore.seedDefaultAdmin();
  feedbackStore = new FeedbackStore(rawDb);

  // Initial pull + polling — only if MW is connected
  if (bot && sync) {
    await doPull();
    setInterval(async () => {
      if (!syncRunning) await doSyncRecent();
    }, SYNC_INTERVAL);
  }

  log(`Sync server ready on :${PORT}`);
}

async function doPull(synthesize = true) {
  if (!sync || syncRunning) return;
  syncRunning = true;
  try {
    log("Pulling all pages from MediaWiki...");
    const r = await sync.pullAll({ verbose: false });
    log(`Pull done: imported=${r.imported} skipped=${r.skipped}`);

    if (synthesize && r.imported > 0) {
      // Load persistent map + category members to filter synthesized pages
      const synthMap = await loadSynthesisMap();
      const allTitles = await (bot as any).getAllPages({ limit: 500 });
      // Pages tagged [[Category:OpenFS Synthesized]] are our own output — skip them
      const synthesizedTitles = new Set(await (bot as any).getCategoryMembers("OpenFS Synthesized", 500));
      const sourceTitles = allTitles.filter(
        (t: string) => !t.startsWith("OpenFS:") && !synthesizedTitles.has(t)
      );

      const newTitles = sourceTitles.filter((t: string) => !synthMap[t]);

      // Always rehydrate WASM wiki from Category:OpenFS Synthesized so /pages, /map, /query work
      log("Rehydrating wiki from Category:OpenFS Synthesized...");
      const synthTitles = await (bot as any).getCategoryMembers("OpenFS Synthesized", 500);
      let rehydrated = 0;
      for (const title of synthTitles) {
        try {
          const page = await (bot as any).getPage(title);
          if (!page?.content?.trim()) continue;
          // Find openfsPath from map (reverse lookup by title)
          const entry = Object.values(synthMap).find((e: any) =>
            e.openfsPath && title.toLowerCase().replace(/\s+/g, "-") === e.openfsPath.replace(/^\/wiki\//, "").replace(/\.md$/, "")
          ) as any;
          const openfsPath = entry?.openfsPath ?? `/wiki/${title.toLowerCase().replace(/\s+/g, "-")}.md`;
          // Prepend # Title heading so AgentWiki can extract the page title for /map matching
          await (sync as any).wiki.agentFs.ingest({ [openfsPath]: `# ${title}\n\n${page.content}` });
          rehydrated++;
        } catch { /* non-fatal */ }
      }
      log(`Rehydrated ${rehydrated} wiki pages from MW.`);

      if (newTitles.length === 0) {
        log(`Synthesis map up to date (${Object.keys(synthMap).length} pages already mapped) — skipping LLM.`);
      } else {
        log(`Synthesizing ${newTitles.length} new pages (${Object.keys(synthMap).length} already mapped)...`);
        for (const title of newTitles) {
          try {
            const page = await (bot as any).getPage(title);
            if (!page?.content?.trim()) continue;
            const result = await (sync as any).wiki.ingest(title, `# ${page.title}\n\n${page.content}`);
            if (result.pagesCreated.length || result.pagesUpdated.length) {
              log(`  synthesized: ${title} → created:${result.pagesCreated.length} updated:${result.pagesUpdated.length}`);
            }
            // Record in map (use first created/updated path as the openfsPath)
            const openfsPath = result.pagesCreated[0] ?? result.pagesUpdated[0] ?? "";
            synthMap[title] = { openfsPath, synthesizedAt: new Date().toISOString() };

            // Push synthesized wiki pages back to MW
            for (const p of [...result.pagesCreated, ...result.pagesUpdated]) {
              try {
                await (sync as any).pushPage(p, `OpenFS synthesis from ${title}`, { synthesized: true });
                log(`  pushed to MW: ${p}`);
              } catch(e) { /* non-fatal */ }
            }
          } catch (e) {
            log(`  skipped synthesis for ${title}: ${(e as Error).message}`);
          }
        }
        // Persist map back to MW so next restart skips these
        await saveSynthesisMap(synthMap);
        log(`Synthesis map saved (${Object.keys(synthMap).length} entries) to disk.`);
      }
    }

    lastSync = Date.now();
  } finally {
    syncRunning = false;
  }
}

async function doSyncRecent(limit = 20) {
  if (!sync || syncRunning) return;
  syncRunning = true;
  try {
    // Only sync human edits — skip our own bot pushes
    const changes = await bot!.getRecentChanges(limit, { hideBots: true });
    const synthSet = new Set(await bot!.getCategoryMembers("OpenFS Synthesized", 500));
    // Skip synthesized pages (we pushed them, no need to re-ingest)
    const humanEdits = changes.filter(c => !synthSet.has(c.title));
    const titles: string[] = [];
    for (const c of humanEdits) {
      try {
        await sync.pullPage(c.title);
        titles.push(c.title);
      } catch { /* skip */ }
    }
    if (titles.length) log(`Synced ${titles.length} human edits: ${titles.join(", ")}`);
    lastSync = Date.now();
  } finally {
    syncRunning = false;
  }
}

// ── LLM ──────────────────────────────────────────────────────────────────────

function makeLlm() {
  const key = process.env.ANTHROPIC_API_KEY;
  return {
    async complete(system: string, prompt: string, opts?: { maxTokens?: number }): Promise<string> {
      if (!key) throw new Error("ANTHROPIC_API_KEY not set");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
          max_tokens: opts?.maxTokens ?? 4096,
          system,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const d = await res.json() as any;
      if (d.error) throw new Error(d.error.message);
      return d.content[0].text;
    },
  };
}

// ── HTTP API ──────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    // GET /status
    if (url.pathname === "/status") {
      const synthMap = bot ? await loadSynthesisMap().catch(() => ({})) : {};
      return json({
        ok: !!sync,
        lastSync: lastSync ? new Date(lastSync).toISOString() : null,
        syncRunning,
        mwUrl: MW_PUBLIC_URL,
        mwUser: MW_USER,
        synthesizedCount: Object.keys(synthMap).length,
      });
    }

    // ── OpenFS filesystem endpoints (/fs/*) ──────────────────────────────────
    // Expose server-side AgentFs (bun:sqlite) so the terminal can run ls/cat/exec/stats

    // ── Integration endpoints (/integrations/*) ──────────────────────────────

    if (url.pathname === "/integrations" && req.method === "GET") {
      if (!integrations) return json({ error: "not ready" }, 503);
      return json(integrations.list());
    }

    if (url.pathname === "/integrations" && req.method === "POST") {
      if (!integrations) return json({ error: "not ready" }, 503);
      const { type, name, config } = await req.json() as any;
      if (!type || !name || !config) return json({ error: "type, name, config required" }, 400);
      const integration = integrations.create(type, name, config);
      return json(integration, 201);
    }

    const integrationDeleteMatch = url.pathname.match(/^\/integrations\/([^/]+)$/);
    if (integrationDeleteMatch && req.method === "DELETE") {
      if (!integrations) return json({ error: "not ready" }, 503);
      integrations.delete(integrationDeleteMatch[1]);
      return json({ ok: true });
    }

    const integrationSyncMatch = url.pathname.match(/^\/integrations\/([^/]+)\/sync$/);
    if (integrationSyncMatch && req.method === "POST") {
      if (!integrations || !sync) return json({ error: "not ready" }, 503);
      const id = integrationSyncMatch[1];
      try {
        const result = await integrations.sync(id, (sync as any).wiki.agentFs);
        log(`[integrations] synced ${id}: ${result.synced} docs`);
        return json(result);
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    const integrationDocsMatch = url.pathname.match(/^\/integrations\/([^/]+)\/docs$/);
    if (integrationDocsMatch && req.method === "GET") {
      if (!integrations) return json({ error: "not ready" }, 503);
      return json(integrations.listDocs(integrationDocsMatch[1]));
    }

    const integrationLogsMatch = url.pathname.match(/^\/integrations\/([^/]+)\/logs$/);
    if (integrationLogsMatch && req.method === "GET") {
      if (!integrations) return json({ error: "not ready" }, 503);
      const limit = parseInt(url.searchParams.get("limit") ?? "200");
      return json(integrations.getLogs(integrationLogsMatch[1], limit));
    }

    const integrationTreeMatch = url.pathname.match(/^\/integrations\/([^/]+)\/tree$/);
    if (integrationTreeMatch && req.method === "GET") {
      if (!integrations) return json({ error: "not ready" }, 503);
      return json(integrations.getTree(integrationTreeMatch[1]));
    }

    const integrationLibrariesMatch = url.pathname.match(/^\/integrations\/([^/]+)\/libraries$/);
    if (integrationLibrariesMatch && req.method === "GET") {
      if (!integrations) return json({ error: "not ready" }, 503);
      try {
        const libs = await integrations.listLibraries(integrationLibrariesMatch[1]);
        return json(libs);
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    const integrationBrowseMatch = url.pathname.match(/^\/integrations\/([^/]+)\/browse$/);
    if (integrationBrowseMatch && req.method === "GET") {
      if (!integrations) return json({ error: "not ready" }, 503);
      try {
        const driveId   = url.searchParams.get("drive_id") ?? undefined;
        const folderId  = url.searchParams.get("folder_id") ?? "root";
        const result = await integrations.browse(integrationBrowseMatch[1], driveId, folderId);
        return json(result);
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    const integrationPushS3Match = url.pathname.match(/^\/integrations\/([^/]+)\/push-to-s3$/);
    if (integrationPushS3Match && req.method === "POST") {
      if (!integrations) return json({ error: "not ready" }, 503);
      try {
        const { files } = await req.json() as any;
        if (!Array.isArray(files) || !files.length) return json({ error: "files array required" }, 400);
        const result = await integrations.pushRawToS3(integrationPushS3Match[1], files);
        return json(result);
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    const integrationS3Match = url.pathname.match(/^\/integrations\/([^/]+)\/s3-sync$/);
    if (integrationS3Match && req.method === "POST") {
      if (!integrations || !sync) return json({ error: "not ready" }, 503);
      try {
        const result = await integrations.syncToS3(integrationS3Match[1], (sync as any).wiki.agentFs);
        return json(result);
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    const integrationEmbedMatch = url.pathname.match(/^\/integrations\/([^/]+)\/embed$/);
    if (integrationEmbedMatch && req.method === "POST") {
      if (!integrations || !sync) return json({ error: "not ready" }, 503);
      try {
        const result = await integrations.embedDocs(integrationEmbedMatch[1], (sync as any).wiki.agentFs);
        return json(result);
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    const integrationIngestS3Match = url.pathname.match(/^\/integrations\/([^/]+)\/ingest-from-s3$/);
    if (integrationIngestS3Match && req.method === "POST") {
      if (!integrations) return json({ error: "not ready" }, 503);
      try {
        const result = await integrations.ingestFromS3(integrationIngestS3Match[1]);
        return json(result);
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    const integrationGetMatch = url.pathname.match(/^\/integrations\/([^/]+)$/);
    if (integrationGetMatch && req.method === "GET") {
      if (!integrations) return json({ error: "not ready" }, 503);
      const item = integrations.get(integrationGetMatch[1]);
      if (!item) return json({ error: "not found" }, 404);
      return json(item);
    }

    if (integrationGetMatch && req.method === "PATCH") {
      if (!integrations) return json({ error: "not ready" }, 503);
      const body = await req.json() as any;
      integrations.update(integrationGetMatch[1], body);
      return json(integrations.get(integrationGetMatch[1]));
    }

    // ── OpenFS filesystem endpoints (/fs/*) ──────────────────────────────────

    if (url.pathname === "/fs/stats") {
      if (!sync) return json({ error: "not ready" }, 503);
      return json((sync as any).wiki.agentFs.stats());
    }

    if (url.pathname === "/fs/ls") {
      if (!sync) return json({ error: "not ready" }, 503);
      const dir = url.searchParams.get("dir") ?? "/";
      const entries = await (sync as any).wiki.agentFs.ls(dir).catch(() => []);
      return json({ entries });
    }

    if (url.pathname === "/fs/cat") {
      if (!sync) return json({ error: "not ready" }, 503);
      const path = url.searchParams.get("path") ?? "";
      if (!path) return json({ error: "path required" }, 400);
      try {
        const content = await (sync as any).wiki.agentFs.read(path);
        return json({ content });
      } catch (e) { return json({ error: (e as Error).message }, 404); }
    }

    if (url.pathname === "/fs/exec" && req.method === "POST") {
      if (!sync) return json({ error: "not ready" }, 503);
      const { command } = await req.json() as any;
      const result = await (sync as any).wiki.agentFs.exec(command);
      return json(result);
    }

    if (url.pathname === "/fs/search" && req.method === "POST") {
      if (!sync) return json({ error: "not ready" }, 503);
      const { query } = await req.json() as any;
      const paths = await (sync as any).wiki.agentFs.search(query).catch(() => []);
      return json({ results: (paths as string[]).map(p => ({ path: p })) });
    }

    // POST /pull — re-pull everything from MW
    if (url.pathname === "/pull" && req.method === "POST") {
      doPull().catch(e => log(`pull error: ${e.message}`));
      return json({ queued: true });
    }

    // POST /sync-recent — pull recent changes
    if (url.pathname === "/sync-recent" && req.method === "POST") {
      doSyncRecent().catch(e => log(`sync-recent error: ${e.message}`));
      return json({ queued: true });
    }

    // GET /recent-changes — recent MW changes with bot/human/synthesized labels
    if (url.pathname === "/recent-changes") {
      if (!bot) return json([]);
      const limit = parseInt(url.searchParams.get("limit") ?? "30");
      const [changes, synthSet] = await Promise.all([
        bot.getRecentChanges(limit),
        bot.getCategoryMembers("OpenFS Synthesized", 500).then(t => new Set(t)),
      ]);
      const synthMap = await loadSynthesisMap();
      const sourceSet = new Set(Object.keys(synthMap));
      const annotated = changes.map(c => ({
        ...c,
        type: synthSet.has(c.title) ? "synthesized"
            : sourceSet.has(c.title) ? "source"
            : "human",
        mwUrl: `${MW_PUBLIC_URL}/wiki/${encodeURIComponent(c.title.replace(/ /g, "_"))}`,
      }));
      return json(annotated);
    }

    // GET /synth-map — show the persistent synthesis map
    if (url.pathname === "/synth-map") {
      if (!bot) return json({});
      const map = await loadSynthesisMap();
      return json(map);
    }

    // POST /resynth — force re-synthesis of a specific MW source page
    if (url.pathname === "/resynth" && req.method === "POST") {
      if (!sync || !bot) return json({ error: "not ready" }, 503);
      const { title } = await req.json() as any;
      try {
        const page = await (bot as any).getPage(title);
        if (!page?.content?.trim()) return json({ error: "page empty or not found" }, 404);
        const result = await (sync as any).wiki.ingest(title, `# ${page.title}\n\n${page.content}`);
        const openfsPath = result.pagesCreated[0] ?? result.pagesUpdated[0] ?? "";
        // Update map entry
        const synthMap = await loadSynthesisMap();
        synthMap[title] = { openfsPath, synthesizedAt: new Date().toISOString() };
        for (const p of [...result.pagesCreated, ...result.pagesUpdated]) {
          try { await (sync as any).pushPage(p, `OpenFS re-synthesis from ${title}`, { synthesized: true }); } catch { /* non-fatal */ }
        }
        await saveSynthesisMap(synthMap);
        return json({ ok: true, ...result });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    // POST /push — push OpenFS pages back to MW
    if (url.pathname === "/push" && req.method === "POST") {
      if (!sync) return json({ error: "not ready" }, 503);
      const r = await sync.pushAll({ verbose: true });
      return json(r);
    }

    // POST /migrate — copy all local MW pages to a remote MW instance
    // Body: { targetUrl, username, password, summary? }
    if (url.pathname === "/migrate" && req.method === "POST") {
      if (!bot) return json({ error: "local MW not connected" }, 503);
      try {
        const { targetUrl, username, password, summary = "Migrated from OpenFS local wiki" } = await req.json() as any;
        if (!targetUrl || !username || !password) return json({ error: "targetUrl, username, password required" }, 400);

        const remote = new MwBot({ baseUrl: targetUrl, username, password });
        await remote.login();
        log(`[migrate] Logged into remote MW at ${targetUrl} as ${username}`);

        const titles = await bot.getAllPages({ limit: 500 });
        log(`[migrate] Found ${titles.length} pages to migrate`);

        let pushed = 0, failed = 0;
        const errors: string[] = [];
        for (const title of titles) {
          try {
            const page = await bot.getPage(title);
            if (!page?.content?.trim()) { log(`[migrate] skip empty: ${title}`); continue; }
            await remote.editPage(title, page.content, summary);
            log(`[migrate] pushed: ${title}`);
            pushed++;
            // Small delay to avoid rate limiting on the remote MW
            await new Promise(r => setTimeout(r, 300));
          } catch (e: any) {
            log(`[migrate] failed: ${title} — ${e.message}`);
            errors.push(`${title}: ${e.message}`);
            failed++;
            // Back off longer on rate limit errors
            if ((e.message ?? "").includes("ratelimited")) {
              log(`[migrate] rate limited — waiting 5s`);
              await new Promise(r => setTimeout(r, 5000));
            }
          }
        }
        return json({ ok: true, total: titles.length, pushed, failed, errors });
      } catch (e: any) { return json({ error: e.message }, 500); }
    }

    // POST /query — RAG: grep + semantic search always, then LLM answers with context
    if (url.pathname === "/query" && req.method === "POST") {
      if (!sync) return json({ answer: "Knowledge base not connected. Set MW_URL to enable wiki sync.", sources: [] });
      const { question, persist } = await req.json() as any;

      // Special case: list pages
      if (/what pages|list pages|all pages|pages exist/i.test(question)) {
        const pages = await (sync as any).wiki.pages();
        const answer = `There are **${pages.length} pages** in the knowledge base:\n\n${pages.map((p: any) => `- ${p.title}`).join("\n")}`;
        return json({ answer, citations: [] });
      }

      // Special case: ingest URL
      const urlMatch = question.match(/ingest\s+(https?:\/\/\S+)/i);
      if (urlMatch) {
        const targetUrl = urlMatch[1];
        try {
          const res = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenFS/1.0)" }, signal: AbortSignal.timeout(15_000) });
          const html = await res.text();
          const text = html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/\s{2,}/g," ").trim().slice(0,8000);
          const title = new URL(targetUrl).pathname.split("/").filter(Boolean).pop()?.replace(/[-_]/g," ").replace(/\b\w/g,(c:string)=>c.toUpperCase()) ?? "Web Page";
          const result = await (sync as any).wiki.ingest(title, text);
          for (const p of [...result.pagesCreated, ...result.pagesUpdated]) { try { await sync!.pushPage(p, `OpenFS agent ingest: ${targetUrl}`); } catch {} }
          return json({ answer: `Ingested **${title}** — ${result.pagesCreated.length} pages created, ${result.pagesUpdated.length} updated.`, citations: [] });
        } catch (e) { return json({ answer: `Failed to ingest: ${(e as Error).message}`, citations: [] }); }
      }

      const chromaStore = new ChromaStore({
        collection: "openfs-knowledge",
        chromaUrl: CHROMA_URL,
      });

      // Strip question/stop words before FTS5 so "what pages are for basketball?" → "basketball"
      const STOP = new Set(["what","which","where","when","who","how","do","does","did","is","are","was","were","have","has","had","can","could","would","should","will","shall","may","might","be","been","a","an","the","and","or","but","in","on","at","to","for","of","with","by","from","about","pages","page","topics","topic","anything","something","tell","me","you","know","show","list","find","search","give","there","any","some","all","your","my","our","i","we","they","it","this","that","these","those"]);
      const grepQuery = question.toLowerCase().replace(/[?!.,]/g,"").split(/\s+/).filter(w => !STOP.has(w) && w.length > 2).join(" ") || question;

      // ── 1. Always run grep + semantic in parallel ──
      const [grepPathsRaw, semanticResultsRaw] = await Promise.all([
        (sync as any).wiki.agentFs.search(grepQuery).catch(() => []),
        chromaStore.init().then(() => chromaStore.semanticSearch(question, { topK: 8, minScore: 0.25 })).catch((e: any) => { log(`[query] semantic search error: ${e.message}`); return []; }),
      ]);
      const grepPaths = grepPathsRaw as string[];
      const semanticResults = semanticResultsRaw as any[];

      // ── 2. Fetch grep results ──
      type Citation = { path: string; title: string; excerpt: string; score?: number; source?: string; matchType?: string };
      const citations: Citation[] = [];
      const contextBlocks: string[] = [];
      const grepPathSet = new Set(grepPaths);

      /** Strip MW/markdown markup and return clean plain-text excerpt */
      function cleanExcerpt(raw: string, maxLen = 200): string {
        return raw
          .replace(/={2,}[^=]+=+/g, "")          // ==Section Headers==
          .replace(/^#+\s+.*/gm, "")              // # Markdown headers
          .replace(/\[\/[^\]]+\s([^\]]+)\]/g, "$1") // [/wiki/foo.md Title] → Title
          .replace(/\[\[([^\]|]+)\|?[^\]]*\]\]/g, "$1") // [[WikiLink|text]] → WikiLink
          .replace(/`[^`]+`/g, "")               // `code`
          .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // **bold** / *italic*
          .replace(/\s{2,}/g, " ")
          .trim()
          .slice(0, maxLen);
      }

      for (const p of (grepPaths as string[]).slice(0, 6)) {
        try {
          const content = await (sync as any).wiki.agentFs.read(p);
          const title = p.split("/").pop()?.replace(/\.md$/,"").replace(/-/g," ") ?? p;
          citations.push({ path: p, title, excerpt: cleanExcerpt(content), matchType: "keyword" });
          contextBlocks.push(`[Wiki: ${title}]\n${content.slice(0, 800)}`);
        } catch {}
      }

      // ── 3. Merge semantic results with hybrid scoring ──
      // Boost score by 0.15 if the page also showed up in grep (keyword + semantic match)
      for (const r of semanticResults as any[]) {
        const existing = citations.find(c => c.source === r.source || c.path === r.source);
        const grepHit = grepPathSet.has(r.source);
        const boostedScore = Math.min(1, r.score + (grepHit ? 0.15 : 0));
        if (existing) {
          // Upgrade the existing grep citation with the semantic score
          existing.score = boostedScore;
          existing.matchType = "keyword+semantic";
        } else {
          citations.push({ path: r.source, title: r.title, excerpt: cleanExcerpt(r.content), score: boostedScore, source: r.source, matchType: "semantic" });
          contextBlocks.push(`[Source: ${r.title} (${(boostedScore*100).toFixed(0)}% match)]\n${r.content.slice(0, 600)}`);
        }
      }

      // Sort: keyword+semantic first, then by score desc
      citations.sort((a, b) => {
        const order = { "keyword+semantic": 0, "keyword": 1, "semantic": 2 };
        const ao = order[a.matchType as keyof typeof order] ?? 3;
        const bo = order[b.matchType as keyof typeof order] ?? 3;
        if (ao !== bo) return ao - bo;
        return (b.score ?? 0) - (a.score ?? 0);
      });

      // ── 4. LLM answers with the merged context ──
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);

      const context = contextBlocks.length
        ? contextBlocks.join("\n\n---\n\n")
        : "No results found in the knowledge base.";

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: `You are the OpenFS AI assistant. Answer the question using ONLY the provided context. Be concise and direct. Cite sources by name.`,
          messages: [{ role: "user", content: `Context:\n${context}\n\nQuestion: ${question}` }],
        }),
      });
      const d = await res.json() as any;
      if (d.error) return json({ answer: `Error: ${d.error.message}`, citations });
      const answer = d.content?.[0]?.text ?? "No answer.";

      return json({ answer, citations: citations.slice(0, 6) });
    }

    // POST /query-agent — agentic tool-calling loop for power commands
    // (ingest URL, expand topic, read specific page, CLI-style operations)
    // Use /query for normal questions — this is for explicit agent actions
    if (url.pathname === "/query-agent" && req.method === "POST") {
      if (!sync) return json({ answer: "Knowledge base not connected. Set MW_URL to enable wiki sync.", sources: [] });
      const { question } = await req.json() as any;

      const chromaStore = new ChromaStore({
        collection: "openfs-knowledge",
        chromaUrl: CHROMA_URL,
      });

      const agentCitations: Array<{ path: string; title: string; excerpt: string; score?: number; source?: string }> = [];

      const TOOLS = [
        // ── Search & Read ──
        { name: "semantic_search", description: "Search the knowledge base by meaning/concept. Use for 'how does X work', 'what is Y', finding related topics.", input_schema: { type: "object", properties: { query: { type: "string" }, topK: { type: "number", description: "Results to return, default 6" } }, required: ["query"] } },
        { name: "grep_wiki", description: "Full-text search across wiki pages for exact terms, names, or keywords.", input_schema: { type: "object", properties: { query: { type: "string" }, dir: { type: "string", description: "Directory to search, default /wiki" } }, required: ["query"] } },
        { name: "read_page", description: "Read the full content of a specific OpenFS page by its path (e.g. /wiki/foo.md).", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
        // ── Ingest & Build ──
        { name: "ingest_url", description: "Fetch a URL, extract its content, and synthesize wiki pages from it.", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
        { name: "expand_topic", description: "Pull all semantically related content and synthesize a comprehensive wiki page for a topic.", input_schema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } },
        { name: "embed_wiki", description: "Re-embed all wiki pages into the Chroma vector store. Use after bulk ingest or pull.", input_schema: { type: "object", properties: {}, required: [] } },
        // ── Sync ──
        { name: "push_page", description: "Push a specific OpenFS page to MediaWiki.", input_schema: { type: "object", properties: { path: { type: "string", description: "OpenFS path like /wiki/foo.md" } }, required: ["path"] } },
        // ── Maintenance ──
        { name: "run_lint", description: "Run wiki health checks (L1-L10): orphans, missing sections, index drift, broken refs, embedding gaps.", input_schema: { type: "object", properties: {}, required: [] } },
        { name: "read_log", description: "Read the wiki activity log to see recent operations (ingest, lint, embed, pull, push).", input_schema: { type: "object", properties: {}, required: [] } },
        { name: "append_log", description: "Append an entry to the activity log after completing an operation.", input_schema: { type: "object", properties: { operation: { type: "string" }, title: { type: "string" }, detail: { type: "string" } }, required: ["operation", "title"] } },
      ];

      async function runAgentTool(name: string, input: any): Promise<string> {
        // Meta/index pages that should never appear in topic search results
        // Normalize path by stripping spaces/underscores/hyphens before comparing
        const META_SLUGS = ["wikiindex", "wikilog", "log", "schema", "wikischema", "about", "changelog", "wikichangelog", "index"];
        const normSlug = (p: string) => (p.split("/").pop() ?? "").replace(/\.md$/i, "").toLowerCase().replace(/[-_ ]/g, "");
        const isMetaPage = (p: string) => META_SLUGS.some(s => normSlug(p) === s || normSlug(p).startsWith(s));

        if (name === "semantic_search") {
          try {
            await chromaStore.init();
            const results = (await chromaStore.semanticSearch(input.query, { topK: input.topK ?? 6 }))
              .filter(r => !isMetaPage(r.source ?? ""));
            for (const r of results) {
              if (!agentCitations.find(c => c.source === r.source))
                agentCitations.push({ path: r.source, title: r.title, excerpt: r.content.slice(0, 200), score: r.score, source: r.source });
            }
            return results.length ? results.map(r => `[${r.title}] score=${r.score.toFixed(2)}\n${r.content}`).join("\n\n---\n\n") : "No results.";
          } catch { return "Semantic search unavailable."; }
        }
        if (name === "grep_wiki") {
          const allPaths = await (sync as any).wiki.agentFs.search(input.query).catch(() => []);
          const dir = input.dir ?? "/wiki";
          const paths = (allPaths as string[])
            .filter((p: string) => p.startsWith(dir))
            .filter((p: string) => !isMetaPage(p));
          const out = await Promise.all(paths.slice(0, 8).map(async (p: string) => {
            try {
              const content = await (sync as any).wiki.agentFs.read(p);
              if (!agentCitations.find(c => c.path === p))
                agentCitations.push({ path: p, title: p.split("/").pop()?.replace(/\.md$/, "").replace(/-/g, " ") ?? p, excerpt: content.slice(0, 200) });
              return `[${p}]\n${content.slice(0, 600)}`;
            } catch { return null; }
          }));
          return out.filter(Boolean).join("\n\n---\n\n") || "No results.";
        }
        if (name === "ingest_url") {
          const res = await fetch(input.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenFS/1.0)" }, signal: AbortSignal.timeout(15_000) });
          const html = await res.text();
          const text = html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/\s{2,}/g," ").trim().slice(0,8000);
          const title = new URL(input.url).pathname.split("/").filter(Boolean).pop()?.replace(/[-_]/g," ").replace(/\b\w/g,(c:string)=>c.toUpperCase()) ?? "Web Page";
          const result = await (sync as any).wiki.ingest(title, text);
          for (const p of [...result.pagesCreated, ...result.pagesUpdated]) { try { await sync!.pushPage(p, `Agent ingest: ${input.url}`); } catch {} }
          return `Ingested "${title}" — ${result.pagesCreated.length} created, ${result.pagesUpdated.length} updated.`;
        }
        if (name === "expand_topic") {
          try {
            await chromaStore.init();
            const results = await chromaStore.semanticSearch(input.topic, { topK: 20 });
            if (!results.length) return `No content for: ${input.topic}`;
            const combined = results.map(r => `# ${r.title}\n\n${r.content}`).join("\n\n---\n\n").slice(0,12000);
            const wikiResult = await (sync as any).wiki.ingest(input.topic, combined);
            const path = wikiResult.pagesCreated[0] ?? wikiResult.pagesUpdated[0];
            if (path) { try { await sync!.pushPage(path, `Topic expansion: ${input.topic}`); } catch {} }
            for (const r of results.slice(0,5)) agentCitations.push({ path: r.source, title: r.title, excerpt: r.content.slice(0,200), score: r.score, source: r.source });
            return `Expanded "${input.topic}" → ${path ?? "updated existing"}. Drew from ${results.length} sources.`;
          } catch { return `Could not expand: ${input.topic}`; }
        }
        if (name === "read_page") {
          const content = await (sync as any).wiki.agentFs.read(input.path).catch(() => null);
          if (!content) return `Not found: ${input.path}`;
          agentCitations.push({ path: input.path, title: input.path.split("/").pop()?.replace(/\.md$/, "").replace(/-/g, " ") ?? input.path, excerpt: content.slice(0,200) });
          return content;
        }
        if (name === "embed_wiki") {
          const { chunkDocument } = await import("../../agent-knowledge/src/chunker.js");
          const store = new ChromaStore({ collection: "openfs-knowledge", chromaUrl: CHROMA_URL });
          await store.init();
          const pages = await (sync as any).wiki.pages();
          let chunksStored = 0;
          const embedErrors: string[] = [];
          for (const page of pages) {
            try {
              const raw = await (sync as any).wiki.agentFs.read(page.path);
              if (!raw?.trim()) continue;
              // Strip wikitext markup so embeddings reflect actual content, not markup noise
              const content = raw
                .replace(/^={1,6}\s*(.+?)\s*={1,6}\s*$/gm, '$1') // =Heading= → Heading
                .replace(/'''(.+?)'''/g, '$1')                     // bold
                .replace(/''(.+?)''/g, '$1')                       // italic
                .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$2||$1') // [[Link|Text]] → Text
                .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')  // [url text] → text
                .replace(/\{\{[^}]+\}\}/g, '')                     // {{templates}}
                .replace(/<[^>]+>/g, '')                           // <html tags>
                .replace(/\n{3,}/g, '\n\n')                        // excess blank lines
                .trim();
              const chunks = chunkDocument(page.path, page.title, content, { chunkSize: 1200, overlap: 200 }).map((c: any) => ({ ...c, topic: "wiki" }));
              await store.upsertChunks(chunks);
              chunksStored += chunks.length;
            } catch (e: any) {
              embedErrors.push(`${page.path}: ${e.message}`);
              log(`[embed_wiki] error embedding ${page.path}: ${e.message}`);
            }
          }
          const errMsg = embedErrors.length ? ` (${embedErrors.length} errors: ${embedErrors.slice(0,3).join('; ')})` : '';
          return `Embedded ${pages.length} pages, ${chunksStored} chunks into openfs-knowledge.${errMsg}`;
        }
        if (name === "push_page") {
          try {
            await sync!.pushPage(input.path, "OpenFS agent push");
            return `Pushed ${input.path} to MediaWiki.`;
          } catch (e) { return `Push failed: ${(e as Error).message}`; }
        }
        if (name === "run_lint") {
          const pages = await (sync as any).wiki.pages() as any[];
          const wikiPages = pages.filter((p: any) => p.path.startsWith("/wiki/") && !p.path.includes("/index") && !p.path.includes("/log"));
          const issues: string[] = [];
          const contents = new Map<string, string>();
          await Promise.all(wikiPages.map(async (p: any) => { try { contents.set(p.path, await (sync as any).wiki.agentFs.read(p.path)); } catch {} }));
          // L1: orphans
          for (const p of wikiPages) {
            const slug = p.path.split("/").pop()!;
            if (![...contents.entries()].some(([src, c]) => src !== p.path && (c.includes(p.path) || c.includes(slug))))
              issues.push(`L1 (orphan): ${p.path}`);
          }
          // L2: missing overview
          for (const [path, content] of contents) {
            if (!/##\s+overview|==overview==/i.test(content)) issues.push(`L2 (no overview): ${path}`);
          }
          // L7: index drift
          let idx = ""; try { idx = await (sync as any).wiki.agentFs.read("/wiki/wiki-index.md"); } catch {}
          for (const p of wikiPages) { if (idx && !idx.includes(p.path) && !idx.includes(p.title)) issues.push(`L7 (not in index): ${p.path}`); }
          return issues.length
            ? `Found ${issues.length} issues:\n${issues.slice(0, 20).join("\n")}`
            : `All checks passed across ${wikiPages.length} pages.`;
        }
        if (name === "read_log") {
          try {
            const content = await (sync as any).wiki.agentFs.read("/wiki/log.md");
            return content.slice(-3000) || "Log is empty.";
          } catch { return "No log found at /wiki/log.md"; }
        }
        if (name === "append_log") {
          const date = new Date().toISOString().slice(0, 10);
          const entry = `\n## [${date}] ${input.operation} | ${input.title}\n${input.detail ?? ""}\n`;
          try {
            let existing = ""; try { existing = await (sync as any).wiki.agentFs.read("/wiki/log.md"); } catch {}
            await (sync as any).wiki.agentFs.ingest({ "/wiki/log.md": existing + entry });
            return `Logged: [${date}] ${input.operation} | ${input.title}`;
          } catch (e) { return `Log append failed: ${(e as Error).message}`; }
        }
        return `Unknown tool: ${name}`;
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);

      const agentMessages: any[] = [{ role: "user", content: question }];
      let agentAnswer = "";

      for (let turn = 0; turn < 8; turn++) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
            max_tokens: 2048,
            system: `You are the OpenFS AI agent. You have full access to the OpenFS knowledge base via tools.

ALWAYS use tools before answering. For any question about content or topics, call semantic_search and grep_wiki in parallel first.
For reading a specific page, call read_page. For health checks, call run_lint. To see recent activity, call read_log.
After ingesting, expanding, or embedding — call append_log to record what you did.
Never answer from memory alone. Cite sources by path.`,
            tools: TOOLS,
            messages: agentMessages,
          }),
        });
        const d = await res.json() as any;
        if (d.error) { agentAnswer = `Error: ${d.error.message}`; break; }
        agentMessages.push({ role: "assistant", content: d.content });
        if (d.stop_reason === "end_turn") { agentAnswer = d.content.find((b: any) => b.type === "text")?.text ?? ""; break; }
        if (d.stop_reason === "tool_use") {
          const toolResults: any[] = [];
          for (const block of d.content) {
            if (block.type !== "tool_use") continue;
            log(`[query-agent] ${block.name}(${JSON.stringify(block.input).slice(0,80)})`);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: await runAgentTool(block.name, block.input) });
          }
          agentMessages.push({ role: "user", content: toolResults });
        }
      }

      return json({ answer: agentAnswer, citations: agentCitations });
    }

    // POST /ingest — ingest a document and push to MW
    if (url.pathname === "/ingest" && req.method === "POST") {
      if (!sync) return json({ error: "not ready" }, 503);
      const { title, content } = await req.json() as any;
      const result = await sync.ingestAndSync(title, content, { verbose: true });
      return json(result);
    }

    // POST /push-page — push a single OpenFS page to MW
    if (url.pathname === "/push-page" && req.method === "POST") {
      if (!sync) return json({ error: "not ready" }, 503);
      const { path } = await req.json() as any;
      await sync.pushPage(path);
      const title = path.split("/").pop()?.replace(/\.md$/, "").replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()) ?? path;
      return json({ ok: true, title });
    }

    // POST /ingest-url — server-side fetch a URL then ingest (avoids browser CORS)
    if (url.pathname === "/ingest-url" && req.method === "POST") {
      if (!sync) return json({ error: "not ready" }, 503);
      const { url: targetUrl } = await req.json() as any;
      if (!targetUrl) return json({ error: "url required" }, 400);
      let html: string;
      try {
        const res = await fetch(targetUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenFS/1.0; +https://openfs.derekethandavis.com)" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return json({ error: `HTTP ${res.status}` }, 502);
        html = await res.text();
      } catch (e) {
        return json({ error: `Fetch failed: ${(e as Error).message}` }, 502);
      }
      // Strip tags, collapse whitespace
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/\s{2,}/g, " ").trim();
      // Derive a title from the URL path
      const urlPath = new URL(targetUrl).pathname;
      const title = urlPath.split("/").filter(Boolean).pop()
        ?.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()) ?? "Web Page";
      const result = await (sync as any).wiki.ingest(title, text);
      for (const p of [...result.pagesCreated, ...result.pagesUpdated]) {
        try { await (sync as any).pushPage(p, `OpenFS ingest from ${targetUrl}`); } catch { /* non-fatal */ }
      }
      return json({ ok: true, title, pagesCreated: result.pagesCreated, pagesUpdated: result.pagesUpdated });
    }

    // POST /edit — directly write a MW page
    if (url.pathname === "/edit" && req.method === "POST") {
      if (!bot) return json({ error: "not ready" }, 503);
      const { title, content, summary } = await req.json() as any;
      await bot.editPage(title, content, summary ?? "OpenFS sync");
      return json({ ok: true, title });
    }

    // GET /map — show link status between OpenFS and MW
    // Source of truth: Category:OpenFS Synthesized = pages we own in MW
    if (url.pathname === "/map") {
      if (!sync || !bot) return json({ linked: [], ofsOnly: [], mwOnly: [], summary: { linked: 0, ofsOnly: 0, mwOnly: 0 } });

      const [ofsPages, synthTitles, allMwTitles] = await Promise.all([
        (sync as any).wiki.pages(),
        bot.getCategoryMembers("OpenFS Synthesized", 500),
        bot.getAllPages({ limit: 1000 }),
      ]);

      const synthSet = new Set(synthTitles.map((t: string) => t.toLowerCase()));

      // linked = every MW page tagged Category:OpenFS Synthesized
      // Try to find the matching OpenFS page by title (case-insensitive)
      const linked: any[] = [];
      for (const mwTitle of synthTitles) {
        const ofsPage = ofsPages.find((p: any) =>
          p.title.toLowerCase() === mwTitle.toLowerCase()
        );
        linked.push({
          openfsPath: ofsPage?.path ?? null,
          openfsTitle: ofsPage?.title ?? mwTitle,
          mwTitle,
          mwUrl: `${MW_PUBLIC_URL}/wiki/${encodeURIComponent(mwTitle.replace(/ /g, "_"))}`,
        });
      }

      // ofsOnly = OpenFS pages whose title doesn't appear in the category
      const ofsOnly = ofsPages
        .filter((p: any) => !synthSet.has(p.title.toLowerCase()))
        .map((p: any) => ({ openfsPath: p.path, openfsTitle: p.title }));

      // mwOnly = MW pages not in Category:OpenFS Synthesized (human/source pages)
      const mwOnly = allMwTitles.filter((t: string) => !synthSet.has(t.toLowerCase()));

      return json({
        linked,
        ofsOnly,
        mwOnly,
        summary: { linked: linked.length, ofsOnly: ofsOnly.length, mwOnly: mwOnly.length },
      });
    }

    // GET /pages — list OpenFS pages
    if (url.pathname === "/pages") {
      if (!sync) return json([]);
      const pages = await (sync as any).wiki.pages();
      return json(pages.map((p: any) => ({ path: p.path, title: p.title, size: p.size })));
    }

    // GET /mw-pages — list MW pages
    if (url.pathname === "/mw-pages") {
      if (!bot) return json([]);
      const titles = await bot.getAllPages({ limit: 1000 });
      return json(titles);
    }

    // GET /ls?dir=/wiki — list files in an OpenFS directory
    if (url.pathname === "/ls") {
      if (!sync) return json({ error: "not ready" }, 503);
      const dir = url.searchParams.get("dir") ?? "/wiki";
      const entries = await (sync as any).wiki.agentFs.ls(dir);
      return json(entries);
    }

    // GET /cat?path=/wiki/foo.md — read a specific OpenFS file
    if (url.pathname === "/cat") {
      if (!sync) return json({ error: "not ready" }, 503);
      const path = url.searchParams.get("path");
      if (!path) return json({ error: "path required" }, 400);
      try {
        const content = await (sync as any).wiki.agentFs.read(path);
        return json({ path, content });
      } catch (e) {
        return json({ error: (e as Error).message }, 404);
      }
    }

    // POST /grep — search across OpenFS files
    if (url.pathname === "/grep" && req.method === "POST") {
      if (!sync) return json({ error: "not ready" }, 503);
      const { query, dir } = await req.json() as any;
      const paths = await (sync as any).wiki.agentFs.search(query);
      // Filter by dir if provided
      const filtered = dir ? paths.filter((p: string) => p.startsWith(dir)) : paths;
      // Return paths + snippet of matching content
      const results = await Promise.all(
        filtered.slice(0, 20).map(async (path: string) => {
          try {
            const content = await (sync as any).wiki.agentFs.read(path);
            // Find lines containing query terms
            const lines = content.split("\n");
            const qWords = query.toLowerCase().split(/\s+/);
            const matches = lines
              .map((line: string, i: number) => ({ line: line.trim(), num: i + 1 }))
              .filter(({ line }: { line: string }) =>
                qWords.some((w: string) => line.toLowerCase().includes(w))
              )
              .slice(0, 3);
            return { path, matches };
          } catch {
            return { path, matches: [] };
          }
        })
      );
      return json(results);
    }

    // POST /s3-ingest — bulk ingest an S3 bucket into Chroma + wiki
    if (url.pathname === "/s3-ingest" && req.method === "POST") {
      const {
        bucket, prefix, topic, limit,
        chromaCollection, chromaUrl,
        s3Endpoint, s3Region, s3AccessKeyId, s3SecretAccessKey,
        synthesize = true,
      } = await req.json() as any;

      if (!bucket) return json({ error: "bucket required" }, 400);

      const llm = makeLlm();
      const pipeline = new S3KnowledgePipeline(
        {
          bucket, prefix, topic, limit,
          chromaCollection: chromaCollection ?? "openfs-knowledge",
          chromaUrl: chromaUrl ?? (CHROMA_URL),
          s3Endpoint: s3Endpoint ?? process.env.S3_ENDPOINT ?? process.env.MINIO_S3_URL,
          s3Region: s3Region ?? process.env.AWS_REGION ?? "us-east-1",
          s3AccessKeyId: s3AccessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? process.env.MINIO_ACCESS_KEY,
          s3SecretAccessKey: s3SecretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? process.env.MINIO_SECRET_KEY,
          onProgress: (p) => log(`[s3-ingest] ${p.done}/${p.total} — ${p.file} (${p.chunks} chunks)`),
        },
        llm,
        synthesize && sync ? (sync as any).wiki : undefined,
      );

      try {
        log(`[s3-ingest] Starting pipeline: bucket=${bucket} prefix=${prefix ?? "/"} topic=${topic ?? "untagged"}`);
        const result = await pipeline.run();

        // Push synthesized wiki pages to MW
        for (const p of [...result.wikiPagesCreated, ...result.wikiPagesUpdated]) {
          try { await sync?.pushPage(p, `OpenFS S3 ingest: ${bucket}/${prefix ?? ""}`); } catch { /* non-fatal */ }
        }

        log(`[s3-ingest] Done: ${result.filesProcessed} files, ${result.chunksStored} chunks, ${result.entitiesExtracted} entities`);
        return json({ ok: true, ...result });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    // POST /kg-ingest-wiki — embed all current OpenFS wiki pages into Chroma
    if (url.pathname === "/kg-ingest-wiki" && req.method === "POST") {
      if (!sync) return json({ error: "not ready" }, 503);
      try {
        const { collection, topic } = (req.headers.get("content-length") !== "0" ? await req.json().catch(() => ({})) : {}) as any;

        const store = new ChromaStore({
          collection: collection ?? "openfs-knowledge",
          chromaUrl: CHROMA_URL,
        });
        // Reset collection to wipe stale vectors from previous embed runs
        log(`[kg-ingest-wiki] resetting collection "${collection ?? "openfs-knowledge"}"…`);
        await store.reset();

        const { chunkDocument } = await import("../../agent-knowledge/src/chunker.js");
        const pages = await (sync as any).wiki.pages();
        let chunksStored = 0;
        const errors: string[] = [];

        for (const page of pages) {
          try {
            const raw = await (sync as any).wiki.agentFs.read(page.path);
            if (!raw?.trim()) continue;
            const content = raw
              .replace(/^={1,6}\s*(.+?)\s*={1,6}\s*$/gm, '$1')
              .replace(/'''(.+?)'''/g, '$1')
              .replace(/''(.+?)''/g, '$1')
              .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$2||$1')
              .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')
              .replace(/\{\{[^}]+\}\}/g, '')
              .replace(/<[^>]+>/g, '')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            const chunks = chunkDocument(page.path, page.title, content, { chunkSize: 1200, overlap: 200 })
              .map((c: any) => ({ ...c, topic: topic ?? "wiki" }));
            await store.upsertChunks(chunks);
            chunksStored += chunks.length;
            log(`[kg-ingest-wiki] embedded: ${page.title} (${chunks.length} chunks)`);
          } catch (e) {
            errors.push(`${page.path}: ${(e as Error).message}`);
          }
        }

        return json({ ok: true, pagesEmbedded: pages.length, chunksStored, errors });
      } catch (e: any) { return json({ error: e.message }, 500); }
    }

    // POST /kg-search — semantic search across embedded corpus
    if (url.pathname === "/kg-search" && req.method === "POST") {
      const { query, topK, topic, mode, collection } = await req.json() as any;
      if (!query) return json({ error: "query required" }, 400);

      const store = new ChromaStore({
        collection: collection ?? "openfs-knowledge",
        chromaUrl: CHROMA_URL,
      });
      await store.init();

      const results = mode === "text"
        ? await store.textSearch(query, { topic })
        : await store.semanticSearch(query, { topK: topK ?? 10, topic });

      return json({ results });
    }

    // POST /kg-expand — expand a topic: search → synthesize → wiki page
    if (url.pathname === "/kg-expand" && req.method === "POST") {
      if (!sync) return json({ error: "not ready" }, 503);
      const { topic, topK, collection } = await req.json() as any;
      if (!topic) return json({ error: "topic required" }, 400);

      const pipeline = new S3KnowledgePipeline(
        {
          bucket: "__search_only__",
          chromaCollection: collection ?? "openfs-knowledge",
          chromaUrl: CHROMA_URL,
        },
        makeLlm(),
        (sync as any).wiki,
      );

      const { results, wikiPath } = await pipeline.expandTopic(topic, {
        topK: topK ?? 20,
        synthesize: true,
      });

      if (wikiPath) {
        try { await sync.pushPage(wikiPath, `OpenFS topic expansion: ${topic}`); } catch { /* non-fatal */ }
      }

      return json({ topic, resultCount: results.length, wikiPath });
    }

    // GET /log — return wiki activity log
    if (url.pathname === "/log") {
      if (!sync) return json({ error: "not ready" }, 503);
      try {
        const content = await (sync as any).wiki.agentFs.read("/wiki/log.md");
        return json({ content });
      } catch {
        return json({ content: "No log yet." });
      }
    }

    // POST /log/append — append an entry to log.md
    if (url.pathname === "/log/append" && req.method === "POST") {
      if (!sync) return json({ error: "not ready" }, 503);
      const { operation, title, detail } = await req.json() as any;
      const date = new Date().toISOString().slice(0, 10);
      const entry = `\n## [${date}] ${operation} | ${title}\n${detail ?? ""}\n`;
      try {
        let existing = "";
        try { existing = await (sync as any).wiki.agentFs.read("/wiki/log.md"); } catch {}
        await (sync as any).wiki.agentFs.ingest({ "/wiki/log.md": existing + entry });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
      return json({ ok: true });
    }

    // POST /lint — run wiki health checks (L1-L10)
    if (url.pathname === "/lint" && req.method === "POST") {
      if (!sync) return json({ error: "not ready" }, 503);

      const issues: Array<{ rule: string; severity: "error" | "warn"; path: string; detail: string; fix: string }> = [];
      const pages = await (sync as any).wiki.pages() as Array<{ path: string; title: string; size: number }>;
      const wikiPages = pages.filter((p: any) => p.path.startsWith("/wiki/") && !p.path.includes("/index") && !p.path.includes("/log"));

      // ── Read all wiki content (batch) ──
      const pageContents = new Map<string, string>();
      await Promise.all(wikiPages.map(async (p: any) => {
        try { pageContents.set(p.path, await (sync as any).wiki.agentFs.read(p.path)); } catch {}
      }));

      // ── L1: Orphan pages (no inbound links from other pages) ──
      for (const p of wikiPages) {
        const slug = p.path.split("/").pop()!;
        const linkedFrom = [...pageContents.entries()].some(([src, content]) =>
          src !== p.path && (content.includes(p.path) || content.includes(slug))
        );
        if (!linkedFrom) {
          issues.push({ rule: "L1", severity: "warn", path: p.path, detail: "No inbound links from other pages", fix: "Link from wiki-index.md or a related page" });
        }
      }

      // ── L2: Missing Overview section ──
      for (const [path, content] of pageContents) {
        if (!/##\s+overview|==overview==/i.test(content)) {
          issues.push({ rule: "L2", severity: "warn", path, detail: "Missing ## Overview section", fix: "Add a 2-4 sentence ## Overview section" });
        }
      }

      // ── L7: Index drift — pages not listed in wiki-index.md ──
      let indexContent = "";
      try { indexContent = await (sync as any).wiki.agentFs.read("/wiki/wiki-index.md"); } catch {}
      for (const p of wikiPages) {
        if (indexContent && !indexContent.includes(p.path) && !indexContent.includes(p.title)) {
          issues.push({ rule: "L7", severity: "error", path: p.path, detail: `Not listed in wiki-index.md`, fix: "Append entry to wiki-index.md" });
        }
      }

      // ── L9: Broken source references ──
      for (const [path, content] of pageContents) {
        const srcRefs = [...content.matchAll(/`?\/sources\/([^\s`\]]+)`?/g)].map(m => `/sources/${m[1]}`);
        for (const src of srcRefs) {
          try { await (sync as any).wiki.agentFs.read(src); } catch {
            issues.push({ rule: "L9", severity: "error", path, detail: `Broken source reference: ${src}`, fix: "Remove reference or ingest the source" });
          }
        }
      }

      // ── L10: Embedding gaps (count comparison) ──
      try {
        const store = new ChromaStore({ collection: "openfs-knowledge", chromaUrl: CHROMA_URL });
        await store.init();
        const embeddedCount = await store.count();
        const expectedMin = wikiPages.length * 2; // at least 2 chunks per page
        if (embeddedCount < expectedMin) {
          issues.push({ rule: "L10", severity: "warn", path: "/wiki/", detail: `Only ${embeddedCount} chunks in Chroma for ${wikiPages.length} pages (expected ≥${expectedMin})`, fix: "Run: openfs embed wiki" });
        }
      } catch {
        issues.push({ rule: "L10", severity: "warn", path: "/wiki/", detail: "Chroma unavailable — cannot check embedding gaps", fix: "Ensure Chroma is running" });
      }

      const summary = {
        total: issues.length,
        errors: issues.filter(i => i.severity === "error").length,
        warnings: issues.filter(i => i.severity === "warn").length,
        pagesChecked: wikiPages.length,
      };

      log(`[lint] ${summary.errors} errors, ${summary.warnings} warnings across ${summary.pagesChecked} pages`);
      return json({ ok: true, summary, issues });
    }

    // ── S3 browser proxy (/s3/*) — all calls go through here so the UI avoids CORS ──
    // Adds auth header before forwarding to adapter-s3-api.

    const S3_API = (process.env.MINIO_API_URL ?? "http://adapter-s3-api:8080").replace(/\/$/, "");
    const S3_AUTH_HEADER = { Authorization: "Bearer demo-token" };

    // GET /s3/buckets — list all buckets
    if (url.pathname === "/s3/buckets" && req.method === "GET") {
      try {
        const r = await fetch(`${S3_API}/api/v1/buckets/`, { headers: S3_AUTH_HEADER });
        const data = await r.json();
        return json(data);
      } catch (e) {
        return json({ error: (e as Error).message }, 502);
      }
    }

    // GET /s3/browse?bucket=X&prefix=Y — list one folder level
    if (url.pathname === "/s3/browse" && req.method === "GET") {
      const bucket = url.searchParams.get("bucket");
      const prefix = url.searchParams.get("prefix") ?? "";
      if (!bucket) return json({ error: "bucket required" }, 400);
      try {
        const qs = `prefix=${encodeURIComponent(prefix)}&recursive=false`;
        const r  = await fetch(
          `${S3_API}/api/v1/objects/list/${encodeURIComponent(bucket)}?${qs}`,
          { headers: S3_AUTH_HEADER }
        );
        const data = await r.json();
        return json(data);
      } catch (e) {
        return json({ error: (e as Error).message }, 502);
      }
    }

    // GET /s3/raw?bucket=X&key=Y — stream raw file bytes to browser (for native preview)
    if (url.pathname === "/s3/raw" && req.method === "GET") {
      const bucket = url.searchParams.get("bucket");
      const key    = url.searchParams.get("key");
      if (!bucket || !key) return json({ error: "bucket and key required" }, 400);
      try {
        const dlRes = await fetch(
          `${S3_API}/api/v1/objects/download/${encodeURIComponent(bucket)}?object_name=${encodeURIComponent(key)}`,
          { headers: S3_AUTH_HEADER }
        );
        if (!dlRes.ok) return json({ error: `S3 download failed: ${dlRes.status}` }, 502);
        const ct  = dlRes.headers.get("content-type") ?? "application/octet-stream";
        const buf = await dlRes.arrayBuffer();
        return new Response(buf, {
          headers: {
            "Content-Type": ct,
            "Content-Disposition": `inline; filename="${key.split("/").pop()}"`,
            ...CORS,
          },
        });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    // GET /s3/preview?bucket=X&key=Y — download one object, extract text, return preview
    // Downloads via adapter-s3-api (no direct AWS SDK needed here), then runs file-extractor.
    if (url.pathname === "/s3/preview" && req.method === "GET") {
      const bucket = url.searchParams.get("bucket");
      const key    = url.searchParams.get("key");
      if (!bucket || !key) return json({ error: "bucket and key required" }, 400);

      try {
        const dlRes = await fetch(
          `${S3_API}/api/v1/objects/download/${encodeURIComponent(bucket)}?object_name=${encodeURIComponent(key)}`,
          { headers: S3_AUTH_HEADER }
        );
        if (!dlRes.ok) return json({ error: `S3 download failed: ${dlRes.status}` }, 502);

        const contentType = dlRes.headers.get("content-type") ?? "";
        const buf         = await dlRes.arrayBuffer();
        const bytes       = new Uint8Array(buf);
        const filename    = key.split("/").pop() ?? key;

        const { extractText } = await import("../../agent-knowledge/src/file-extractor.js");
        const text      = await extractText(bytes, filename, contentType);
        const charCount = text.length;

        return json({
          bucket,
          key,
          filename,
          contentType,
          sizeBytes: bytes.byteLength,
          charCount,
          truncated: charCount > 8_000,
          text: text.slice(0, 8_000),
        });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    // GET /s3/normalize/rules — all saved + default prompts per doc type
    if (url.pathname === "/s3/normalize/rules" && req.method === "GET") {
      if (!normalizeRules) return json({ error: "server not ready" }, 503);
      return json(normalizeRules.getAll());
    }

    // PUT /s3/normalize/rules — upsert a custom prompt for a doc type
    // Body: { type: "xlsx", prompt: "..." }
    if (url.pathname === "/s3/normalize/rules" && req.method === "PUT") {
      if (!normalizeRules) return json({ error: "server not ready" }, 503);
      const { type, prompt } = await req.json() as any;
      if (!type || !prompt) return json({ error: "type and prompt required" }, 400);
      if (!NORMALIZE_DEFAULT_PROMPTS[type]) return json({ error: `unknown type: ${type}` }, 400);
      normalizeRules.upsert(type, prompt.trim());
      return json({ ok: true, type, updatedAt: new Date().toISOString() });
    }

    // DELETE /s3/normalize/rules?type=xlsx — reset to default
    if (url.pathname === "/s3/normalize/rules" && req.method === "DELETE") {
      if (!normalizeRules) return json({ error: "server not ready" }, 503);
      const type = url.searchParams.get("type") ?? "";
      if (!type) return json({ error: "type param required" }, 400);
      normalizeRules.reset(type);
      return json({ ok: true, type, reset: true });
    }

    // POST /s3/normalize — LLM-powered document normalization for ANY file type.
    // Each type has a tailored system prompt + extraction strategy.
    // Accepts custom `rules` to override/extend the default prompt per type.
    if (url.pathname === "/s3/normalize" && req.method === "POST") {
      const {
        bucket, key,
        model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
        rules = "",         // freeform extra instructions injected into the prompt
        sheets: sheetFilter,
      } = await req.json() as any;

      if (!bucket || !key) return json({ error: "bucket and key required" }, 400);
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey)          return json({ error: "ANTHROPIC_API_KEY not set" }, 500);

      const dlRes = await fetch(
        `${S3_API}/api/v1/objects/download/${encodeURIComponent(bucket)}?object_name=${encodeURIComponent(key)}`,
        { headers: S3_AUTH_HEADER }
      );
      if (!dlRes.ok) return json({ error: `S3 download failed: ${dlRes.status}` }, 502);

      const filename    = key.split("/").pop() ?? key;
      const contentType = dlRes.headers.get("content-type") ?? "";
      const bytes       = new Uint8Array(await dlRes.arrayBuffer());
      const ext         = filename.includes(".") ? "." + filename.split(".").pop()!.toLowerCase() : "";

      // ── Helper: call the LLM ──────────────────────────────────────────────
      async function callLlm(system: string, userMsg: string, maxTokens = 2048): Promise<string> {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": apiKey!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: userMsg }] }),
        });
        const d = await r.json() as any;
        if (d.error) throw new Error(d.error.message);
        return d.content?.[0]?.text ?? "";
      }

      // Resolve system prompt: saved DB prompt > default > empty
      const docTypeKey = ext.replace(".", "") || "txt";
      const basePrompt = normalizeRules?.getPrompt(docTypeKey) ?? NORMALIZE_DEFAULT_PROMPTS[docTypeKey] ?? "";
      const sysPrompt  = rules ? `${basePrompt}\n\nAdditional rules for this call: ${rules}` : basePrompt;

      // ── XLSX / XLS ────────────────────────────────────────────────────────
      if ([".xlsx", ".xls"].includes(ext)) {
        const { extractXlsxSheets, renderSheetMarkdown } = await import("../../agent-knowledge/src/file-extractor.js");
        const rawSheets = await extractXlsxSheets(bytes);
        const results: any[] = [];

        for (const sheet of rawSheets) {
          if (sheetFilter?.length && !sheetFilter.includes(sheet.name)) continue;
          if (!sheet.rows.length) continue;

          const preview  = sheet.rows.slice(0, 40);
          const colCount = Math.max(...preview.map(r => r.length), 1);
          const rowLines = preview.map((row, i) =>
            `${String(i).padStart(2)}: ${Array.from({ length: Math.min(colCount, 20) }, (_, c) =>
              String(row[c] ?? "").trim().slice(0, 40)
            ).join(" | ")}`
          ).join("\n");

          const compact = `Sheet: "${sheet.name}" | ${sheet.rows.length} rows | ${colCount} cols | ${sheet.merges} merged regions\n\n${rowLines}`;

          let analysis: any = {};
          try {
            const txt = await callLlm(sysPrompt, `Analyze this sheet:\n\n${compact}`, 512);
            const m   = txt.match(/\{[\s\S]*\}/);
            if (m) analysis = JSON.parse(m[0]);
          } catch { /* fallback to row 0 */ }

          const normalized = renderSheetMarkdown(
            sheet,
            analysis.header_row    ?? 0,
            analysis.data_start_row ?? 1,
            analysis.col_indices,
          );
          results.push({ sheet: sheet.name, ...analysis, normalized });
        }

        return json({ ok: true, bucket, key, filename, model, type: "xlsx", sheets: results,
          text: results.map(r => r.normalized).join("\n\n") });
      }

      // ── PDF ───────────────────────────────────────────────────────────────
      if (ext === ".pdf") {
        const { extractText } = await import("../../agent-knowledge/src/file-extractor.js");
        const raw = await extractText(bytes, filename, contentType);
        const normalized = await callLlm(sysPrompt, `Clean this PDF text:\n\n${raw.slice(0, 12_000)}`);
        return json({ ok: true, bucket, key, filename, model, type: "pdf", text: normalized,
          originalChars: raw.length, normalizedChars: normalized.length });
      }

      // ── DOCX ──────────────────────────────────────────────────────────────
      if ([".docx", ".doc"].includes(ext)) {
        const { extractText } = await import("../../agent-knowledge/src/file-extractor.js");
        const raw = await extractText(bytes, filename, contentType);
        const normalized = await callLlm(sysPrompt, `Structure this Word document:\n\n${raw.slice(0, 12_000)}`);
        return json({ ok: true, bucket, key, filename, model, type: "docx", text: normalized,
          originalChars: raw.length, normalizedChars: normalized.length });
      }

      // ── Plain text / Markdown / CSV ───────────────────────────────────────
      if ([".txt", ".md", ".mdx", ".csv", ".log", ".rst"].includes(ext)) {
        const raw = new TextDecoder().decode(bytes);
        const normalized = await callLlm(sysPrompt, raw.slice(0, 12_000));
        return json({ ok: true, bucket, key, filename, model, type: docTypeKey, text: normalized,
          originalChars: raw.length, normalizedChars: normalized.length });
      }

      return json({ error: `No normalizer for type: ${ext || contentType}` }, 400);
    }

    // POST /s3/ingest-normalized — same full pipeline as /s3-ingest but skips extraction.
    // Caller supplies already-cleaned text (e.g. from /s3/normalize).
    // Flow: chunk → Chroma embed → entity extraction → wiki.ingest → pushPage to MW.
    // Body: { bucket, key, text, topic?, chunkSize?, synthesize? }
    if (url.pathname === "/s3/ingest-normalized" && req.method === "POST") {
      const {
        bucket, key, text,
        topic      = "s3-normalized",
        chunkSize  = 1200,
        overlap    = 200,
        synthesize = true,
      } = await req.json() as any;

      if (!bucket || !key || !text) return json({ error: "bucket, key, and text required" }, 400);

      const filename = key.split("/").pop() ?? key;
      const title    = filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
      const filePath = `s3/${bucket}/${key}`;

      // 1. Chunk + embed into Chroma
      const { chunkDocument } = await import("../../agent-knowledge/src/chunker.js");
      const store = new ChromaStore({
        collection: "openfs-knowledge",
        chromaUrl: CHROMA_URL,
      });
      await store.init();

      const chunks = chunkDocument(filePath, title, text, { chunkSize, overlap })
        .map((c: any) => ({ ...c, topic }));
      await store.upsertChunks(chunks);
      log(`[ingest-normalized] ${chunks.length} chunks stored for ${key}`);

      // 2. Entity extraction → knowledge graph (same as S3KnowledgePipeline step 5)
      let entitiesExtracted = 0;
      const llm = makeLlm();
      try {
        const { KnowledgeGraphBuilder } = await import("../../agent-knowledge/src/kg-graph.js");
        const kgBuilder = new KnowledgeGraphBuilder(llm);
        const sample = chunks.slice(0, 4).map((c: any) => ({
          source: c.source, title: c.title, content: c.content, score: 1,
        }));
        const { entities, relationships } = await kgBuilder.extractFromChunks(sample, topic);
        entitiesExtracted = entities.length;
        if (sync && entities.length > 0) {
          const kg = kgBuilder.mergeGraph(
            { entities: [], relationships: [], clusters: {}, builtAt: new Date().toISOString() },
            entities, relationships, topic
          );
          const kgFiles = kgBuilder.graphToFiles(kg);
          await (sync as any).wiki.agentFs.ingest(kgFiles);
        }
      } catch (e) {
        log(`[ingest-normalized] entity extraction skipped: ${(e as Error).message}`);
      }

      // 3. Wiki synthesis via agentWiki.ingest (same call the S3 pipeline uses)
      let wikiPagesCreated: string[] = [];
      let wikiPagesUpdated: string[] = [];
      if (synthesize && sync) {
        try {
          const wiki = (sync as any).wiki;
          const wikiResult = await wiki.ingest(title, text.slice(0, 8000));
          wikiPagesCreated = wikiResult.pagesCreated ?? [];
          wikiPagesUpdated = wikiResult.pagesUpdated ?? [];
          // Push each page to MediaWiki (same as /s3-ingest does)
          for (const p of [...wikiPagesCreated, ...wikiPagesUpdated]) {
            try {
              await sync.pushPage(p, `OpenFS normalized ingest: ${bucket}/${key}`);
            } catch { /* non-fatal */ }
          }
          log(`[ingest-normalized] wiki: ${wikiPagesCreated.length} created, ${wikiPagesUpdated.length} updated`);
        } catch (e) {
          log(`[ingest-normalized] wiki synthesis skipped: ${(e as Error).message}`);
        }
      }

      return json({
        ok: true, bucket, key, filename, topic,
        chunksStored: chunks.length,
        entitiesExtracted,
        wikiPagesCreated,
        wikiPagesUpdated,
      });
    }

    // ── Chroma Browser API ────────────────────────────────────────────────────

    // GET /chroma/collections — list all collections with counts
    // NOTE: do NOT call store.init() here — init() calls getOrCreateCollection (POST)
    // which causes _type errors on ChromaDB 0.6+. listCollections() only needs the client.
    if (url.pathname === "/chroma/collections" && req.method === "GET") {
      try {
        const store = new ChromaStore({ chromaUrl: CHROMA_URL });
        return json(await store.listCollections());
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // GET /chroma/chunks?collection=&limit=50&offset=0&topic=&source=
    if (url.pathname === "/chroma/chunks" && req.method === "GET") {
      try {
        const collection = url.searchParams.get("collection") ?? "openfs-knowledge";
        const limit  = parseInt(url.searchParams.get("limit")  ?? "50");
        const offset = parseInt(url.searchParams.get("offset") ?? "0");
        const topic  = url.searchParams.get("topic")  || undefined;
        const source = url.searchParams.get("source") || undefined;

        const store = new ChromaStore({ collection, chromaUrl: CHROMA_URL });
        await store.init();
        const result = await store.listChunks({ limit, offset, topic, source });

        const chunks = result.ids.map((id: string, i: number) => {
          const meta = (result.metadatas[i] as any) ?? {};
          return {
            id,
            source:      meta.source      ?? "",
            title:       meta.title       ?? "",
            topic:       meta.topic       ?? "",
            chunkIndex:  meta.chunkIndex  ?? 0,
            totalChunks: meta.totalChunks ?? 1,
            charCount:   (result.documents[i] ?? "").length,
            content:     (result.documents[i] ?? "").slice(0, 400),
          };
        });
        return json({ total: result.total, offset, limit, chunks });
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // GET /chroma/topics?collection=
    if (url.pathname === "/chroma/topics" && req.method === "GET") {
      try {
        const collection = url.searchParams.get("collection") ?? "openfs-knowledge";
        const store = new ChromaStore({ collection, chromaUrl: CHROMA_URL });
        await store.init();
        return json({ topics: await store.listTopics() });
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // GET /chroma/sources?collection=&topic=
    if (url.pathname === "/chroma/sources" && req.method === "GET") {
      try {
        const collection = url.searchParams.get("collection") ?? "openfs-knowledge";
        const topic = url.searchParams.get("topic") || undefined;
        const store = new ChromaStore({ collection, chromaUrl: CHROMA_URL });
        await store.init();
        const [sources, topics] = await Promise.all([store.listSources(topic), store.listTopics()]);
        return json({ sources: sources.sort(), topics });
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // POST /chroma/search — semantic or text search
    if (url.pathname === "/chroma/search" && req.method === "POST") {
      try {
        const {
          query, collection = "openfs-knowledge",
          mode = "semantic", topK = 10, topic, minScore,
        } = await req.json() as any;
        if (!query) return json({ error: "query required" }, 400);
        const store = new ChromaStore({ collection, chromaUrl: CHROMA_URL });
        await store.init();
        const results = mode === "text"
          ? await store.textSearch(query, { topic })
          : await store.semanticSearch(query, { topK, topic, minScore });
        return json({ results });
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // DELETE /chroma/chunk?collection=&id=
    if (url.pathname === "/chroma/chunk" && req.method === "DELETE") {
      try {
        const collection = url.searchParams.get("collection") ?? "openfs-knowledge";
        const id = url.searchParams.get("id") ?? "";
        if (!id) return json({ error: "id required" }, 400);
        const store = new ChromaStore({ collection, chromaUrl: CHROMA_URL });
        await store.init();
        await store.deleteChunk(id);
        return json({ ok: true, deleted: id });
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // DELETE /chroma/source?collection=&source=
    if (url.pathname === "/chroma/source" && req.method === "DELETE") {
      try {
        const collection = url.searchParams.get("collection") ?? "openfs-knowledge";
        const source = url.searchParams.get("source") ?? "";
        if (!source) return json({ error: "source required" }, 400);
        const store = new ChromaStore({ collection, chromaUrl: CHROMA_URL });
        await store.init();
        await store.deleteSource(source);
        return json({ ok: true, deleted: source });
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // ── Auth endpoints (/auth/*) ─────────────────────────────────────────────

    // POST /auth/login
    // Try local user store first, then fall back to MediaWiki credentials.
    if (url.pathname === "/auth/login" && req.method === "POST") {
      try {
        if (!usersStore) return json({ error: "not ready" }, 503);
        const { username, password } = await req.json() as any;
        if (!username || !password) return json({ error: "username and password required" }, 400);

        // 1. Try local user store
        const localUser = await usersStore.verify(username, password);
        if (localUser) {
          const token = await signJwt({ sub: localUser.id, username: localUser.username, name: localUser.name, role: localUser.role });
          return json({ token, user: localUser });
        }

        // 2. Fall back to MediaWiki credentials
        if (MW_URL) {
          try {
            const mwBot = new MwBot({ baseUrl: MW_URL, username, password: password });
            await mwBot.login();
            // Auto-provision a local user record for this MW user (role: viewer)
            const mwRole = username.toLowerCase() === (MW_USER ?? "admin").toLowerCase() ? "admin" : "viewer";
            try { await usersStore.create(username, username, mwRole, password); } catch {}
            const provisioned = await usersStore.verify(username, password);
            if (provisioned) {
              const token = await signJwt({ sub: provisioned.id, username: provisioned.username, name: provisioned.name, role: provisioned.role });
              return json({ token, user: provisioned });
            }
            // If provisioning failed just issue a token directly
            const token = await signJwt({ sub: username, username, name: username, role: mwRole });
            return json({ token, user: { id: username, username, name: username, role: mwRole } });
          } catch {
            // MW auth failed — fall through to invalid credentials
          }
        }

        return json({ error: "invalid credentials" }, 401);
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // GET /auth/me
    if (url.pathname === "/auth/me" && req.method === "GET") {
      try {
        const payload = await requireAuth(req);
        if (!payload) return json({ error: "unauthorized" }, 401);
        if (!usersStore) return json({ error: "not ready" }, 503);
        const user = usersStore.getById(payload.sub);
        return user ? json(user) : json({ error: "not found" }, 404);
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // GET /auth/users (admin only)
    if (url.pathname === "/auth/users" && req.method === "GET") {
      try {
        const payload = await requireAuth(req);
        if (!payload) return json({ error: "unauthorized" }, 401);
        if (payload.role !== "admin") return json({ error: "forbidden" }, 403);
        if (!usersStore) return json({ error: "not ready" }, 503);
        return json(usersStore.list());
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // POST /auth/users (admin only — create user)
    if (url.pathname === "/auth/users" && req.method === "POST") {
      try {
        const payload = await requireAuth(req);
        if (!payload) return json({ error: "unauthorized" }, 401);
        if (payload.role !== "admin") return json({ error: "forbidden" }, 403);
        if (!usersStore) return json({ error: "not ready" }, 503);
        const { username, name, role, password } = await req.json() as any;
        if (!username || !password) return json({ error: "username and password required" }, 400);
        await usersStore.create(username, name ?? username, role ?? "employee", password);
        return json({ ok: true }, 201);
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // DELETE /auth/users/:id (admin only)
    const userDeleteMatch = url.pathname.match(/^\/auth\/users\/([^/]+)$/);
    if (userDeleteMatch && req.method === "DELETE") {
      try {
        const payload = await requireAuth(req);
        if (!payload) return json({ error: "unauthorized" }, 401);
        if (payload.role !== "admin") return json({ error: "forbidden" }, 403);
        if (payload.sub === userDeleteMatch[1]) return json({ error: "cannot delete yourself" }, 400);
        if (!usersStore) return json({ error: "not ready" }, 503);
        usersStore.delete(userDeleteMatch[1]);
        return json({ ok: true });
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // PATCH /auth/users/:id/password
    const pwChangeMatch = url.pathname.match(/^\/auth\/users\/([^/]+)\/password$/);
    if (pwChangeMatch && req.method === "PATCH") {
      try {
        const payload = await requireAuth(req);
        if (!payload) return json({ error: "unauthorized" }, 401);
        // Users can change their own password; admins can change anyone's
        if (payload.role !== "admin" && payload.sub !== pwChangeMatch[1]) return json({ error: "forbidden" }, 403);
        if (!usersStore) return json({ error: "not ready" }, 503);
        const { password } = await req.json() as any;
        if (!password) return json({ error: "password required" }, 400);
        await usersStore.updatePassword(pwChangeMatch[1], password);
        return json({ ok: true });
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // ── Portal AI query (/portal/query) ──────────────────────────────────────
    // Semantic search → LLM synthesis → answer with cited sources

    if (url.pathname === "/portal/query" && req.method === "POST") {
      try {
        const payload = await requireAuth(req);
        if (!payload) return json({ error: "unauthorized" }, 401);
        const { question, collection, topic, topK, mode } = await req.json() as any;
        if (!question?.trim()) return json({ error: "question required" }, 400);

        const store = new ChromaStore({ collection: collection ?? "openfs-knowledge", chromaUrl: CHROMA_URL });

        // ── Strip stop words for keyword grep ──
        const STOP_PQ = new Set(["what","is","are","the","a","an","how","does","do","why","when","where","who","which","that","this","these","those","and","or","but","in","on","at","to","for","of","with","about","can","will","would","could","should","has","have","had","was","were","be","been","being","it","its","from","by","as","if","then","than","so","also","not","no","any","all","there","their","they","you","we","our","i","my","your"]);
        const grepQuery = question.toLowerCase().replace(/[?!.,]/g,"").split(/\s+/).filter((w: string) => !STOP_PQ.has(w) && w.length > 2).join(" ") || question;

        // ── 1. Run grep + semantic/text in parallel ──
        await store.init();
        const [grepPathsRaw, chromaResults] = await Promise.all([
          sync ? (sync as any).wiki.agentFs.search(grepQuery).catch(() => []) : Promise.resolve([]),
          (async () => {
            if (mode === "text") {
              return store.textSearch(question, { topic: topic || undefined }).then((r: any[]) => r.slice(0, topK ?? 8)).catch(() => []);
            }
            // Semantic mode: try semantic, fall back to text search if nothing passes threshold
            const semResults = await store.semanticSearch(question, { topK: topK ?? 8, topic: topic || undefined, minScore: 0.1 }).catch(() => []);
            if ((semResults as any[]).length > 0) return semResults;
            // Fallback: keyword text search using stop-word-stripped query
            log(`[portal/query] semantic returned 0 results for "${question}", falling back to text search`);
            return store.textSearch(grepQuery || question, { topic: topic || undefined }).then((r: any[]) => r.slice(0, topK ?? 8)).catch(() => []);
          })(),
        ]);
        const grepPaths = grepPathsRaw as string[];
        const grepPathSet = new Set(grepPaths);

        // ── 2. Build merged source list ──
        type PortalSource = { source: string; title: string; content: string; score?: number; matchType: string };
        const sources: PortalSource[] = [];
        const contextBlocks: string[] = [];

        function cleanChunk(raw: string): string {
          const s = (raw || "").trim();
          if (s.startsWith("{") || s.startsWith("[")) { try { JSON.parse(s); return ""; } catch {} }
          return s
            .replace(/^={1,6}\s*(.+?)\s*={1,6}\s*$/gm, "$1")  // =Heading= any level
            .replace(/^#+\s+.*/gm, "")                          // # markdown headers
            .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")     // [[Link|Text]] → Text
            .replace(/\[\[([^\]]+)\]\]/g, "$1")                 // [[Link]] → Link
            .replace(/\[\/\S+\s+([^\]]+)\]/g, "$1")            // [/wiki/file.md Text] → Text
            .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")           // bold/italic
            .replace(/\{\{[^}]+\}\}/g, "")                      // {{templates}}
            .replace(/\s{2,}/g, " ")
            .trim();
        }

        // Add grep (wiki) results first
        for (const p of grepPaths.slice(0, 5)) {
          try {
            const content = await (sync as any).wiki.agentFs.read(p);
            const cleaned = cleanChunk(content);
            if (!cleaned || cleaned.length < 20) continue;
            const title = p.split("/").pop()?.replace(/\.md$/,"").replace(/[-_]/g," ") ?? p;
            sources.push({ source: p, title, content: cleaned, matchType: "keyword" });
            contextBlocks.push(`[${sources.length}] **${title}** (wiki)\n${cleaned.slice(0, 1000)}`);
          } catch {}
        }

        // Merge Chroma results with hybrid scoring
        for (const r of chromaResults as any[]) {
          const cleaned = cleanChunk(r.content || "");
          if (!cleaned || cleaned.length < 20) continue;
          const existing = sources.find(s => s.source === r.source);
          const grepHit = grepPathSet.has(r.source);
          const boosted = Math.min(1, (r.score ?? 0) + (grepHit ? 0.15 : 0));
          if (existing) {
            existing.score = boosted;
            existing.matchType = "keyword+semantic";
          } else {
            sources.push({ source: r.source, title: r.title || r.source, content: cleaned, score: boosted, matchType: grepHit ? "keyword+semantic" : "semantic" });
            contextBlocks.push(`[${sources.length}] **${r.title || r.source}**\n${cleaned.slice(0, 1000)}`);
          }
        }

        // Sort: keyword+semantic > keyword > semantic, then by score
        const ORDER: Record<string,number> = { "keyword+semantic": 0, "keyword": 1, "semantic": 2 };
        sources.sort((a, b) => (ORDER[a.matchType] ?? 3) - (ORDER[b.matchType] ?? 3) || ((b.score ?? 0) - (a.score ?? 0)));

        const context = contextBlocks.length
          ? contextBlocks.slice(0, 10).join("\n\n---\n\n")
          : "No relevant documents found in the knowledge base.";

        const llm = makeLlm();
        const answer = await llm.complete(
          `You are an expert AI assistant for an enterprise knowledge base.

Your task:
1. Read the numbered context documents carefully
2. Write a clear, well-structured answer to the employee's question
3. Use **markdown formatting**: bold key terms, bullet lists for multiple items, headers (##) for distinct sections
4. Cite sources inline using [1], [2] notation — only cite sources you actually used
5. If the context is insufficient, say so briefly and suggest what to search for instead
6. Be accurate and direct — do NOT fabricate information not in the context
7. CRITICAL: Do NOT include a sources list, references section, or document summary at the end of your response. The UI displays sources automatically. End your answer after the last substantive sentence.

Format your response as a synthesized narrative answer only. No trailing source lists. No "Sources:" section. No numbered document index at the end.`,
          `Context documents:\n\n${context}\n\n---\n\nEmployee question: ${question}`
        );

        return json({ answer, sources: sources.slice(0, 10), question });
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // ── Feedback endpoints (/portal/feedback) ────────────────────────────────

    // POST /portal/feedback — record a thumbs up (vote:1) or down (vote:-1)
    if (url.pathname === "/portal/feedback" && req.method === "POST") {
      try {
        const payload = await requireAuth(req);
        if (!payload) return json({ error: "unauthorized" }, 401);
        if (!feedbackStore) return json({ error: "not ready" }, 503);
        const { question, answer, vote, collection, topic } = await req.json() as any;
        if (!question || !answer || (vote !== 1 && vote !== -1))
          return json({ error: "question, answer, and vote (1 or -1) required" }, 400);
        feedbackStore.record({ question, answer, vote, collection, topic,
          userId: payload.sub, username: payload.username });
        return json({ ok: true });
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // GET /portal/feedback — list recent (admin only)
    if (url.pathname === "/portal/feedback" && req.method === "GET") {
      try {
        const payload = await requireAuth(req);
        if (!payload) return json({ error: "unauthorized" }, 401);
        if (payload.role !== "admin") return json({ error: "forbidden" }, 403);
        if (!feedbackStore) return json({ error: "not ready" }, 503);
        const limit = parseInt(url.searchParams.get("limit") ?? "100");
        return json(feedbackStore.list(limit));
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // GET /portal/feedback/stats — aggregate scores
    if (url.pathname === "/portal/feedback/stats" && req.method === "GET") {
      try {
        const payload = await requireAuth(req);
        if (!payload) return json({ error: "unauthorized" }, 401);
        if (!feedbackStore) return json({ error: "not ready" }, 503);
        return json(feedbackStore.stats());
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // GET /portal/feedback/top — most-asked questions with scores
    if (url.pathname === "/portal/feedback/top" && req.method === "GET") {
      try {
        const payload = await requireAuth(req);
        if (!payload) return json({ error: "unauthorized" }, 401);
        if (!feedbackStore) return json({ error: "not ready" }, 503);
        const limit = parseInt(url.searchParams.get("limit") ?? "20");
        return json(feedbackStore.topQuestions(limit));
      } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    return json({ error: "not found" }, 404);
  },
});

async function bootWithRetry(attempts = 3, delayMs = 3000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await boot();
      return;
    } catch (e) {
      console.error(`Boot attempt ${i}/${attempts} failed: ${(e as Error).message}`);
      if (i < attempts) {
        console.log(`Retrying in ${delayMs / 1000}s…`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  console.error("All boot attempts failed — server running in degraded mode (integrations only)");
}

bootWithRetry();
