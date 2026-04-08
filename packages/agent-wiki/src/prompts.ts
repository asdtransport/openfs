/**
 * @openfs/agent-wiki — Prompt templates
 *
 * All exported so you can override or extend them.
 * Each returns a plain string — no framework lock-in.
 */

// ── System prompt ──────────────────────────────────────────────────────────────

export const WIKI_SYSTEM_PROMPT =
  `You are a meticulous wiki maintainer. You synthesize information from raw sources into clear, ` +
  `well-structured markdown pages. You maintain cross-references, flag contradictions, and ensure ` +
  `knowledge compounds over time. Always respond with valid JSON exactly matching the requested schema.`;

// ── Default schema (SCHEMA.md) ─────────────────────────────────────────────────

export const DEFAULT_SCHEMA = `# Wiki Schema

## Directory Layout
- \`/sources/\`         Raw, immutable source documents — never edit these
- \`/wiki/\`            LLM-synthesized knowledge pages (markdown)
- \`/wiki/index.md\`    Catalog of all wiki pages by category (auto-regenerated)
- \`/wiki/log.md\`      Append-only changelog

## Page Conventions
- One clear topic per page
- H1 title at the top
- Cross-references as markdown links: \`[Topic](/wiki/topic.md)\`
- \`## Sources\` section at the bottom citing \`/sources/\` files
- Keep pages under ~800 words; split large topics into sub-pages

## Quality Rules
- No unverified claims — every factual claim needs a source
- No contradictions between pages — newest source wins, old claim gets a note
- Flag uncertainty with \`> **Note:** ...\`
- Mark TODO items as \`<!-- TODO: ... -->\`
`;

// ── Ingest prompt ──────────────────────────────────────────────────────────────

export interface IngestPromptOpts {
  schema: string;
  newSourcePath: string;
  newSourceContent: string;
  relatedPages: Array<{ path: string; content: string }>;
}

export function buildIngestPrompt(opts: IngestPromptOpts): string {
  const pages = opts.relatedPages.length
    ? opts.relatedPages
        .map((p) => `### ${p.path}\n${p.content}`)
        .join("\n\n---\n\n")
    : "(no existing wiki pages yet — create the first ones)";

  return `Update the wiki to integrate a new source document.

## Wiki Schema / Conventions
${opts.schema}

## New Source: ${opts.newSourcePath}
\`\`\`
${opts.newSourceContent}
\`\`\`

## Existing Related Wiki Pages
${pages}

## Instructions
1. Decide which wiki pages need to be created or updated
2. Write each page as complete markdown (not a diff)
3. Integrate information from the source naturally
4. Add cross-reference links between related pages
5. Add the source to each updated page's \`## Sources\` section
6. Do NOT create or modify files in /sources/

Respond with JSON:
\`\`\`json
{
  "pages": [
    { "path": "/wiki/topic.md", "content": "# Title\\n\\n..." }
  ],
  "summary": "one-line summary of changes"
}
\`\`\``;
}

// ── Query prompt ───────────────────────────────────────────────────────────────

export interface QueryPromptOpts {
  schema: string;
  question: string;
  pages: Array<{ path: string; content: string }>;
}

export function buildQueryPrompt(opts: QueryPromptOpts): string {
  const pages = opts.pages.length
    ? opts.pages.map((p) => `### ${p.path}\n${p.content}`).join("\n\n---\n\n")
    : "(wiki is empty — answer from general knowledge and note the gap)";

  return `Answer a question using the wiki knowledge base.

## Wiki Schema
${opts.schema}

## Question
${opts.question}

## Relevant Wiki Pages
${pages}

## Instructions
- Answer directly and concisely
- Cite specific wiki pages by path
- If the wiki doesn't cover something, say so explicitly
- If the answer is valuable new knowledge worth persisting, set "persist" to a wiki path

Respond with JSON:
\`\`\`json
{
  "answer": "...",
  "citations": ["/wiki/page.md"],
  "persist": "/wiki/new-page.md or null",
  "persistContent": "full markdown for new page if persist is set, else null"
}
\`\`\``;
}

// ── Lint prompt ────────────────────────────────────────────────────────────────

export interface LintPromptOpts {
  pages: Array<{ path: string; content: string }>;
}

export function buildLintPrompt(opts: LintPromptOpts): string {
  const pages = opts.pages
    .map((p) => `### ${p.path}\n${p.content.slice(0, 800)}`)
    .join("\n\n---\n\n");

  return `Audit these wiki pages for quality issues.

## Wiki Pages
${pages}

## Issue Types
- \`contradiction\`: two pages make conflicting claims about the same fact
- \`orphan\`: page has no incoming or outgoing links
- \`stale\`: contains "TODO", "WIP", "FIXME", "coming soon", "will be", outdated claims
- \`missing-citation\`: factual claim with no source reference
- \`todo\`: explicit <!-- TODO --> or unchecked checklist items

Respond with JSON:
\`\`\`json
{
  "issues": [
    {
      "page": "/wiki/page.md",
      "type": "contradiction",
      "description": "Page says X but /wiki/other.md says Y"
    }
  ]
}
\`\`\``;
}

// ── Index rebuild prompt ───────────────────────────────────────────────────────

export interface IndexPromptOpts {
  pages: Array<{ path: string; title: string; size: number }>;
}

export function buildIndexPrompt(opts: IndexPromptOpts): string {
  const list = opts.pages
    .map((p) => `- ${p.path} (${p.title}, ${p.size}B)`)
    .join("\n");

  return `Generate a wiki index page that catalogs all pages by category.

## Pages
${list}

Write a \`/wiki/index.md\` file with:
- H1 "Wiki Index"
- Pages grouped into logical categories
- Each entry as a markdown link with a one-line description
- Keep it scannable and flat (no nesting beyond 2 levels)

Respond with JSON:
\`\`\`json
{ "content": "# Wiki Index\\n\\n..." }
\`\`\``;
}
