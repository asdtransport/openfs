/**
 * @openfs/agent-wiki — Types
 *
 * All public interfaces. Import from here for type-only usage.
 */

// ── LLM adapter ────────────────────────────────────────────────────────────────

/**
 * Pluggable LLM interface. Bring your own: Claude, GPT, Gemini, local.
 * Keep it simple — just text in, text out.
 */
export interface LlmAdapter {
  complete(
    system: string,
    user: string,
    opts?: { maxTokens?: number },
  ): Promise<string>;
}

// ── Wiki config ────────────────────────────────────────────────────────────────

export interface WikiOptions {
  /** Directory for raw, immutable source documents. Default: /sources */
  sourcesDir?: string;
  /** Directory for synthesized wiki pages. Default: /wiki */
  wikiDir?: string;
  /** Append-only operation log. Default: /wiki/log.md */
  logPath?: string;
  /** Page catalog, regenerated on each ingest. Default: /wiki/index.md */
  indexPath?: string;
  /** Conventions file read by agent before each operation. Default: /wiki/SCHEMA.md */
  schemaPath?: string;
  /** Max related wiki pages to pass into LLM context per ingest. Default: 8 */
  maxRelatedPages?: number;
  /** Truncate large sources to this char limit before sending to LLM. Default: 6000 */
  maxSourceChars?: number;
  /** Truncate individual wiki pages to this char limit in LLM context. Default: 2000 */
  maxPageChars?: number;
}

// ── Operation results ─────────────────────────────────────────────────────────

export interface IngestResult {
  sourcePath: string;
  /** Wiki pages that were modified */
  pagesUpdated: string[];
  /** Wiki pages that were newly created */
  pagesCreated: string[];
  /** One-line summary written to log.md */
  logEntry: string;
}

export interface QueryResult {
  answer: string;
  /** Wiki pages cited in the answer */
  citations: string[];
  /** Path if answer was valuable enough to persist as a new wiki page */
  persistedPath?: string;
}

export interface LintIssue {
  page: string;
  type: "contradiction" | "orphan" | "stale" | "todo" | "missing-citation";
  description: string;
}

export interface LintResult {
  issues: LintIssue[];
  /** Summary written to log.md */
  logEntry: string;
}

// ── Read models ────────────────────────────────────────────────────────────────

export interface WikiPage {
  path: string;
  title: string;
  content: string;
  size: number;
}

export interface SourceFile {
  path: string;
  size: number;
  content?: string;
}

export interface LogEntry {
  timestamp: string;
  op: "ingest" | "query" | "lint" | "edit";
  summary: string;
}

// ── LLM response shapes (internal, but exported for custom prompt builders) ────

export interface LlmIngestResponse {
  pages: Array<{ path: string; content: string }>;
  summary: string;
}

export interface LlmQueryResponse {
  answer: string;
  citations: string[];
  persist: string | null;
  persistContent: string | null;
}

export interface LlmLintResponse {
  issues: LintIssue[];
}
