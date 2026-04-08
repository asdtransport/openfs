/**
 * @openfs/agent-wiki — AgentWiki
 *
 * A persistent, compounding knowledge base on top of any AgentFs instance.
 * Inspired by Karpathy's LLM Wiki pattern — sources are immutable,
 * wiki pages are LLM-synthesized and compound over time.
 *
 * Usage:
 *   const fs   = await createAgentFs({ writable: true });
 *   const wiki = await AgentWiki.create(fs, myLlm);
 *   await wiki.ingest("/sources/paper.md", rawText);
 *   const { answer } = await wiki.query("how does auth work?");
 */

import type { AgentFs } from "@openfs/wasm";
import type {
  LlmAdapter,
  WikiOptions,
  IngestResult,
  QueryResult,
  LintResult,
  LintIssue,
  WikiPage,
  SourceFile,
  LogEntry,
  LlmIngestResponse,
  LlmQueryResponse,
  LlmLintResponse,
} from "./types";
import {
  WIKI_SYSTEM_PROMPT,
  DEFAULT_SCHEMA,
  buildIngestPrompt,
  buildQueryPrompt,
  buildLintPrompt,
} from "./prompts";

// ── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULTS = {
  sourcesDir:      "/sources",
  wikiDir:         "/wiki",
  logPath:         "/wiki/log.md",
  indexPath:       "/wiki/index.md",
  schemaPath:      "/wiki/SCHEMA.md",
  maxRelatedPages: 8,
  maxSourceChars:  6000,
  maxPageChars:    2000,
} satisfies Required<WikiOptions>;

// ── Helpers ────────────────────────────────────────────────────────────────────

function resolvedOpts(opts: WikiOptions = {}): Required<WikiOptions> {
  return { ...DEFAULTS, ...opts };
}

/** Extract H1 title from markdown, fallback to filename */
function extractTitle(path: string, content: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : path.split("/").pop()!.replace(/\.md$/, "");
}

/** Parse JSON out of LLM response — handles fences, truncation, unescaped newlines */
function parseJson<T>(raw: string): T {
  // Strip markdown fences
  let s = raw
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  // Extract outermost {...} in case LLM adds preamble/postamble
  const start = s.indexOf("{");
  const end   = s.lastIndexOf("}");
  if (start !== -1 && end > start) s = s.slice(start, end + 1);

  // First attempt — clean JSON
  try { return JSON.parse(s) as T; } catch { /* fall through to repair */ }

  // Repair: LLMs often emit literal newlines/tabs inside JSON string values.
  // We scan character by character, tracking whether we're inside a string,
  // and escape control characters that would break JSON.
  let repaired = "";
  let inString = false;
  let escaped  = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { repaired += ch; escaped = false; continue; }
    if (ch === "\\" && inString) { repaired += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; repaired += ch; continue; }
    if (inString) {
      if      (ch === "\n") { repaired += "\\n";  continue; }
      else if (ch === "\r") { repaired += "\\r";  continue; }
      else if (ch === "\t") { repaired += "\\t";  continue; }
    }
    repaired += ch;
  }

  return JSON.parse(repaired) as T;
}

/** Current ISO timestamp */
function now(): string {
  return new Date().toISOString();
}

// ── AgentWiki ──────────────────────────────────────────────────────────────────

export class AgentWiki {
  private constructor(
    private readonly fs: AgentFs,
    private readonly llm: LlmAdapter,
    private readonly opts: Required<WikiOptions>,
  ) {}

  // ── Factory ──────────────────────────────────────────────────────────────────

  static async create(
    fs: AgentFs,
    llm: LlmAdapter,
    opts: WikiOptions = {},
  ): Promise<AgentWiki> {
    const wiki = new AgentWiki(fs, llm, resolvedOpts(opts));
    await wiki.ensureSchema();
    return wiki;
  }

  // ── Schema setup ─────────────────────────────────────────────────────────────

  private async ensureSchema(): Promise<void> {
    if (!this.fs.exists(this.opts.schemaPath)) {
      await this.fs.ingest({ [this.opts.schemaPath]: DEFAULT_SCHEMA });
    }
    if (!this.fs.exists(this.opts.logPath)) {
      await this.fs.ingest({ [this.opts.logPath]: "# Wiki Log\n\n" });
    }
  }

  // ── Core: Ingest ─────────────────────────────────────────────────────────────

  /**
   * Add a source document and synthesize/update wiki pages.
   * The source is stored under sourcesDir; the LLM updates the wiki.
   */
  async ingest(path: string, content: string): Promise<IngestResult> {
    // Normalise path into /sources/
    const sourcePath = path.startsWith(this.opts.sourcesDir)
      ? path
      : `${this.opts.sourcesDir}/${path.replace(/^\//, "")}`;

    // 1. Store raw source
    await this.fs.ingest({ [sourcePath]: content });

    // 2. Find related wiki pages via FTS search on source content
    const keywords = this.extractKeywords(content);
    const relatedPaths = await this.findRelatedPages(keywords);

    // 3. Read related pages
    const relatedPages = await this.readPages(relatedPaths);

    // 4. Build prompt and call LLM
    const schema = await this.schema();
    const prompt = buildIngestPrompt({
      schema,
      newSourcePath: sourcePath,
      newSourceContent: content.slice(0, this.opts.maxSourceChars),
      relatedPages: relatedPages.map((p) => ({
        path: p.path,
        content: p.content.slice(0, this.opts.maxPageChars),
      })),
    });

    const raw = await this.llm.complete(WIKI_SYSTEM_PROMPT, prompt, { maxTokens: 8192 });
    const response = parseJson<LlmIngestResponse>(raw);

    // 5. Write updated/new wiki pages
    const existingPaths = new Set(relatedPaths);
    const pagesUpdated: string[] = [];
    const pagesCreated: string[] = [];

    const writes: Record<string, string> = {};
    for (const page of response.pages) {
      writes[page.path] = page.content;
      if (existingPaths.has(page.path) || this.fs.exists(page.path)) {
        pagesUpdated.push(page.path);
      } else {
        pagesCreated.push(page.path);
      }
    }
    await this.fs.ingest(writes);

    // 6. Append to log
    const logEntry = `[${now()}] ingest: ${sourcePath} → ${response.summary}`;
    await this.appendLog("ingest", response.summary);

    return { sourcePath, pagesUpdated, pagesCreated, logEntry };
  }

  // ── Core: Query ──────────────────────────────────────────────────────────────

  /**
   * Answer a question from the wiki. Optionally persists valuable answers.
   */
  async query(
    question: string,
    opts: { persist?: boolean } = {},
  ): Promise<QueryResult> {
    // Find relevant pages via FTS search
    const paths = await this.fs.search(question);
    let wikiPaths = paths
      .filter((p) => p.startsWith(this.opts.wikiDir))
      .slice(0, this.opts.maxRelatedPages);

    console.log(`[wiki.query] search returned ${paths.length} total, ${wikiPaths.length} wiki paths`);
    // Fallback: if search found nothing, load all wiki pages so LLM always has context
    if (wikiPaths.length === 0) {
      console.log("[wiki.query] no wiki hits — falling back to all wiki pages");
      const allEntries = await this.fs.ls(this.opts.wikiDir);
      wikiPaths = allEntries
        .map((e) => (e.startsWith("/") ? e : `${this.opts.wikiDir}/${e}`))
        .filter((p) => p.endsWith(".md") && !p.endsWith("SCHEMA.md"))
        .slice(0, this.opts.maxRelatedPages);
    }

    const pages = await this.readPages(wikiPaths);
    const schema = await this.schema();

    const prompt = buildQueryPrompt({
      schema,
      question,
      pages: pages.map((p) => ({
        path: p.path,
        content: p.content.slice(0, this.opts.maxPageChars),
      })),
    });

    const raw = await this.llm.complete(WIKI_SYSTEM_PROMPT, prompt);
    const response = parseJson<LlmQueryResponse>(raw);

    // Optionally persist valuable answer
    let persistedPath: string | undefined;
    if (
      (opts.persist ?? false) &&
      response.persist &&
      response.persistContent
    ) {
      await this.fs.ingest({ [response.persist]: response.persistContent });
      persistedPath = response.persist;
      await this.appendLog("query", `Q: ${question} → persisted ${response.persist}`);
    } else {
      await this.appendLog("query", `Q: ${question}`);
    }

    return {
      answer: response.answer,
      citations: response.citations ?? [],
      persistedPath,
    };
  }

  // ── Core: Lint ───────────────────────────────────────────────────────────────

  /**
   * Health-check the wiki. Returns issues found and writes a log entry.
   */
  async lint(): Promise<LintResult> {
    const wikiPaths = (await this.fs.ls(this.opts.wikiDir)).filter((p) =>
      p.endsWith(".md") &&
      !p.endsWith("log.md") &&
      !p.endsWith("index.md") &&
      !p.endsWith("SCHEMA.md"),
    );

    if (!wikiPaths.length) {
      return { issues: [], logEntry: "lint: no pages to check" };
    }

    const pages = await this.readPages(
      wikiPaths.map((p) =>
        p.startsWith("/") ? p : `${this.opts.wikiDir}/${p}`,
      ),
    );

    const prompt = buildLintPrompt({
      pages: pages.map((p) => ({
        path: p.path,
        content: p.content.slice(0, this.opts.maxPageChars),
      })),
    });

    const raw = await this.llm.complete(WIKI_SYSTEM_PROMPT, prompt);
    const response = parseJson<LlmLintResponse>(raw);
    const issues: LintIssue[] = response.issues ?? [];

    const logEntry = issues.length
      ? `lint: ${issues.length} issue(s) found`
      : "lint: wiki looks clean";

    await this.appendLog("lint", logEntry);

    return { issues, logEntry };
  }

  // ── Navigation ────────────────────────────────────────────────────────────────

  /** List all wiki pages (excludes log, index, schema) */
  async pages(): Promise<WikiPage[]> {
    const entries = await this.fs.ls(this.opts.wikiDir);
    const result: WikiPage[] = [];
    for (const e of entries) {
      const path = e.startsWith("/") ? e : `${this.opts.wikiDir}/${e}`;
      if (!path.endsWith(".md")) continue;
      try {
        const content = await this.fs.read(path);
        result.push({
          path,
          title: extractTitle(path, content),
          content,
          size: content.length,
        });
      } catch { /* skip unreadable */ }
    }
    return result;
  }

  /** List all source files */
  async sources(): Promise<SourceFile[]> {
    const entries = await this.fs.ls(this.opts.sourcesDir);
    const result: SourceFile[] = [];
    for (const e of entries) {
      const path = e.startsWith("/") ? e : `${this.opts.sourcesDir}/${e}`;
      try {
        const content = await this.fs.read(path);
        result.push({ path, size: content.length });
      } catch { /* skip */ }
    }
    return result;
  }

  /** Read a single wiki page */
  async readPage(path: string): Promise<WikiPage> {
    const content = await this.fs.read(path);
    return { path, title: extractTitle(path, content), content, size: content.length };
  }

  /** Manually write a wiki page (records an edit log entry) */
  async writePage(path: string, content: string): Promise<void> {
    await this.fs.ingest({ [path]: content });
    await this.appendLog("edit", `manual edit: ${path}`);
  }

  /** Delete a wiki page */
  async deletePage(path: string): Promise<void> {
    await this.fs.remove(path);
    await this.appendLog("edit", `deleted: ${path}`);
  }

  /** Read the schema/conventions file */
  async schema(): Promise<string> {
    try { return await this.fs.read(this.opts.schemaPath); }
    catch { return DEFAULT_SCHEMA; }
  }

  /** Parse the log file into structured entries */
  async readLog(limit = 50): Promise<LogEntry[]> {
    try {
      const raw = await this.fs.read(this.opts.logPath);
      return raw
        .split("\n")
        .filter((l) => l.startsWith("["))
        .slice(-limit)
        .map((l) => {
          const m = l.match(/^\[(.+?)\] (\w+): (.+)$/);
          if (!m) return null;
          return { timestamp: m[1], op: m[2] as LogEntry["op"], summary: m[3] };
        })
        .filter(Boolean) as LogEntry[];
    } catch { return []; }
  }

  /** Direct access to underlying filesystem */
  get agentFs(): AgentFs { return this.fs; }

  // ── Private helpers ────────────────────────────────────────────────────────────

  private async appendLog(op: LogEntry["op"], summary: string): Promise<void> {
    const line = `[${now()}] ${op}: ${summary}`;
    try {
      const existing = await this.fs.read(this.opts.logPath).catch(() => "# Wiki Log\n\n");
      await this.fs.ingest({
        [this.opts.logPath]: existing + line + "\n",
      });
    } catch { /* non-fatal */ }
  }

  private extractKeywords(content: string): string {
    // Simple keyword extraction: take first 200 chars of content, strip markdown
    const text = content
      .replace(/#{1,6}\s/g, "")
      .replace(/[*_`[\]()]/g, "")
      .slice(0, 200);
    return text;
  }

  private async findRelatedPages(keywords: string): Promise<string[]> {
    const allPaths = await this.fs.search(keywords);
    return allPaths
      .filter((p) => p.startsWith(this.opts.wikiDir) && p.endsWith(".md"))
      .slice(0, this.opts.maxRelatedPages);
  }

  private async readPages(
    paths: string[],
  ): Promise<Array<{ path: string; content: string }>> {
    const result: Array<{ path: string; content: string }> = [];
    for (const path of paths) {
      try {
        const content = await this.fs.read(path);
        result.push({ path, content });
      } catch { /* skip missing */ }
    }
    return result;
  }
}

// ── Standalone functions (composable, no class required) ──────────────────────

export { buildIngestPrompt, buildQueryPrompt, buildLintPrompt };
