/**
 * OpenFsMwSync — bridges a MediaWiki instance with @openfs/agent-wiki.
 *
 * Pull:  reads all MediaWiki pages → ingests into OpenFS as /wiki/<Title>.md
 * Push:  takes LLM-generated wiki pages from OpenFS → writes back to MediaWiki
 * Query: answers questions using wiki pages as context, optionally persisting back
 */

import type { AgentWiki } from "@openfs/agent-wiki";
import type { MwBot } from "./bot.js";

export interface SyncOptions {
  /** Prefix for pages in OpenFS. Default: "/wiki" */
  wikiDir?: string;
  /** Prefix for sources in OpenFS. Default: "/sources/mw" */
  sourcesDir?: string;
  /** MediaWiki namespace to sync (0 = main). Default: 0 */
  namespace?: number;
  /** Max pages to pull. Default: 500 */
  maxPages?: number;
}

export class OpenFsMwSync {
  private readonly wikiDir: string;
  private readonly sourcesDir: string;

  constructor(
    private readonly bot: MwBot,
    private readonly wiki: AgentWiki,
    private readonly opts: SyncOptions = {},
  ) {
    this.wikiDir = opts.wikiDir ?? "/wiki";
    this.sourcesDir = opts.sourcesDir ?? "/sources/mw";
  }

  // ── Pull: MediaWiki → OpenFS ───────────────────────────────────────────────

  /**
   * Import all MediaWiki pages into OpenFS so the LLM has full context.
   * Pages land at /sources/mw/<Title>.md as raw sources.
   */
  async pullAll(opts: { verbose?: boolean } = {}): Promise<{ imported: number; skipped: number }> {
    const titles = await this.bot.getAllPages({ namespace: this.opts.namespace, limit: this.opts.maxPages });
    let imported = 0, skipped = 0;

    for (const title of titles) {
      try {
        const page = await this.bot.getPage(title);
        if (!page || !page.content.trim()) { skipped++; continue; }

        const path = `${this.sourcesDir}/${slugify(title)}.md`;
        // Store as source — AgentWiki.ingest() will synthesize wiki pages from it
        await this.wiki.agentFs.ingest({ [path]: `# ${page.title}\n\n${page.content}` });
        imported++;
        if (opts.verbose) console.log(`[sync] pulled: ${title}`);
      } catch (e) {
        if (opts.verbose) console.warn(`[sync] skipped ${title}:`, (e as Error).message);
        skipped++;
      }
    }
    return { imported, skipped };
  }

  /**
   * Pull a single page from MediaWiki into OpenFS.
   */
  async pullPage(title: string): Promise<void> {
    const page = await this.bot.getPage(title);
    if (!page) throw new Error(`Page not found: ${title}`);
    const path = `${this.sourcesDir}/${slugify(title)}.md`;
    await this.wiki.agentFs.ingest({ [path]: `# ${page.title}\n\n${page.content}` });
  }

  // ── Push: OpenFS → MediaWiki ───────────────────────────────────────────────

  /**
   * Write an OpenFS wiki page back to MediaWiki.
   * The page path like /wiki/auth.md becomes "Auth" in MediaWiki.
   */
  async pushPage(openfsPath: string, summary?: string, opts: { synthesized?: boolean } = {}): Promise<void> {
    const content = await this.wiki.agentFs.read(openfsPath);
    // Use the H1 heading as the MW title so it matches the OpenFS page title in the link map.
    // Fall back to path-derived title if no heading found.
    const title = titleFromMarkdown(content) ?? pathToTitle(openfsPath);
    let wikiText = wikiTextFromMarkdown(content);
    // Always tag every OpenFS-managed page so the sync loop knows to skip re-synthesis
    if (!wikiText.includes("[[Category:OpenFS Synthesized]]")) {
      wikiText += "\n\n[[Category:OpenFS Synthesized]]";
    }
    await this.bot.editPage(title, wikiText, summary ?? "OpenFS agent sync");
  }

  /**
   * Push all OpenFS wiki pages to MediaWiki.
   */
  async pushAll(opts: { verbose?: boolean } = {}): Promise<{ pushed: number; failed: number }> {
    const pages = await this.wiki.pages();
    let pushed = 0, failed = 0;

    for (const page of pages) {
      try {
        await this.pushPage(page.path);
        pushed++;
        if (opts.verbose) console.log(`[sync] pushed: ${page.title}`);
      } catch (e) {
        failed++;
        if (opts.verbose) console.warn(`[sync] failed ${page.path}:`, (e as Error).message);
      }
    }
    return { pushed, failed };
  }

  // ── Ingest + Sync ──────────────────────────────────────────────────────────

  /**
   * Ingest a new source doc into OpenFS (LLM synthesizes wiki pages),
   * then push the resulting pages back to MediaWiki.
   */
  async ingestAndSync(title: string, rawContent: string, opts: { verbose?: boolean } = {}): Promise<{
    pagesCreated: string[];
    pagesUpdated: string[];
    pushed: string[];
  }> {
    const result = await this.wiki.ingest(title, rawContent);

    const pushed: string[] = [];
    for (const p of [...result.pagesCreated, ...result.pagesUpdated]) {
      try {
        await this.pushPage(p);
        pushed.push(p);
        if (opts.verbose) console.log(`[sync] ingest+push: ${p}`);
      } catch (e) {
        if (opts.verbose) console.warn(`[sync] push failed ${p}:`, (e as Error).message);
      }
    }

    return { ...result, pushed };
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  /**
   * Answer a question. If persist=true and the LLM decides it's worth saving,
   * the answer is written to both OpenFS and MediaWiki.
   */
  async query(question: string, opts: { persist?: boolean; verbose?: boolean } = {}): Promise<{ answer: string; citations: string[] }> {
    const result = await this.wiki.query(question, { persist: opts.persist });

    if (result.persistedPath) {
      try {
        await this.pushPage(result.persistedPath, `Q: ${question.slice(0, 80)}`);
        if (opts.verbose) console.log(`[sync] persisted answer → ${result.persistedPath}`);
      } catch (e) {
        if (opts.verbose) console.warn(`[sync] persist push failed:`, (e as Error).message);
      }
    }

    return { answer: result.answer, citations: result.citations ?? [] };
  }

  // ── Recent changes sync ───────────────────────────────────────────────────

  /**
   * Pull pages that have changed recently in MediaWiki and re-ingest them.
   */
  async syncRecentChanges(limit = 10): Promise<string[]> {
    const changes = await this.bot.getRecentChanges(limit);
    const synced: string[] = [];
    for (const c of changes) {
      await this.pullPage(c.title);
      synced.push(c.title);
    }
    return synced;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .replace(/-+/g, "-");
}

function pathToTitle(path: string): string {
  // /wiki/auth-overview.md → "Auth Overview"
  const base = path.split("/").pop()?.replace(/\.md$/, "") ?? "Untitled";
  return base
    .replace(/-/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function titleFromMarkdown(content: string): string | null {
  // Extract the first H1 heading: "# LLM Synthesis Pipeline" → "LLM Synthesis Pipeline"
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Very light markdown → wikitext conversion.
 * Handles headers, bold, italic, links, lists.
 * Good enough for LLM-generated content.
 */
function wikiTextFromMarkdown(md: string): string {
  return md
    .replace(/^#### (.+)$/gm, "====$1====")
    .replace(/^### (.+)$/gm, "===$1===")
    .replace(/^## (.+)$/gm, "==$1==")
    .replace(/^# (.+)$/gm, "=$1=")
    .replace(/\*\*(.+?)\*\*/g, "'''$1'''")
    .replace(/\*(.+?)\*/g, "''$1''")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "[$2 $1]")
    .replace(/^- /gm, "* ")
    .replace(/^  - /gm, "** ")
    .replace(/^```[\w]*\n([\s\S]*?)```/gm, "<syntaxhighlight>\n$1</syntaxhighlight>");
}
