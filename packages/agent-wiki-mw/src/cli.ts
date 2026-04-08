#!/usr/bin/env bun
/**
 * @openfs/agent-wiki-mw CLI
 *
 * Usage:
 *   bun run packages/agent-wiki-mw/src/cli.ts <command> [args]
 *
 * Commands:
 *   login                        Test login to MediaWiki
 *   pull [--all | <Title>]       Pull pages from MW into OpenFS
 *   push [--all | <path>]        Push OpenFS pages to MW
 *   query "<question>"           Ask the LLM a question using wiki context
 *   ingest <file> [title]        Ingest a file and push synthesized pages to MW
 *   sync-recent [limit]          Pull recently changed pages
 *   pages                        List all OpenFS wiki pages
 *   sources                      List all source files in OpenFS
 *   stats                        Show DB stats
 *   edit <Title> <content>       Directly edit a MW page
 *   get <Title>                  Read a MW page
 *   search <query>               Search MW
 *
 * Env vars:
 *   MW_URL        MediaWiki base URL (default: http://localhost:8082)
 *   MW_USER       Username (default: Derek)
 *   MW_PASS       Password (default: Yugioh4444!)
 *   ANTHROPIC_API_KEY  For LLM commands (query, ingest)
 *   OPENAI_API_KEY     Alternative LLM
 */

import { MwBot } from "./bot.js";
import { OpenFsMwSync } from "./sync.js";

const MW_URL  = process.env.MW_URL  ?? "http://localhost:8082";
const MW_USER = process.env.MW_USER ?? "Derek";
const MW_PASS = process.env.MW_PASS ?? "Yugioh4444!";

const args = process.argv.slice(2);
const cmd  = args[0];

// ── Colour helpers ─────────────────────────────────────────────────────────
const c = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  blue:   (s: string) => `\x1b[34m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function usage() {
  console.log(`
${c.bold("@openfs/agent-wiki-mw")} — MediaWiki + OpenFS AI agent

${c.bold("Usage:")} bun run packages/agent-wiki-mw/src/cli.ts <command>

${c.bold("Commands:")}
  login                     Test login to ${MW_URL}
  get <Title>               Read a page from MediaWiki
  search <query>            Search MediaWiki
  edit <Title> <content>    Directly write a page
  pull <Title>              Pull one page from MW into OpenFS
  pull --all                Pull ALL pages from MW into OpenFS
  push <path>               Push one OpenFS page to MW
  push --all                Push ALL OpenFS pages to MW
  pages                     List OpenFS wiki pages
  sources                   List source files in OpenFS
  stats                     Show filesystem stats
  sync-recent [N]           Pull last N recently changed pages (default 10)
  query "<question>"        Ask LLM using wiki context
  ingest <file> [title]     Ingest file → LLM synthesizes → push to MW

${c.bold("Env vars:")}
  MW_URL=${MW_URL}
  MW_USER=${MW_USER}
  MW_PASS=***
  ANTHROPIC_API_KEY  (required for query/ingest)
`);
}

async function makeBot(): Promise<MwBot> {
  const bot = new MwBot({ baseUrl: MW_URL, username: MW_USER, password: MW_PASS });
  await bot.login();
  console.log(c.green(`✓ Logged in as ${MW_USER} @ ${MW_URL}`));
  return bot;
}

async function makeSync(bot: MwBot): Promise<OpenFsMwSync> {
  const { createAgentFs } = await import("@openfs/wasm");
  const { AgentWiki } = await import("@openfs/agent-wiki");

  const llm = makeLlm();
  const fs   = await createAgentFs({ writable: true, wasmPath: undefined });
  const wiki = await AgentWiki.create(fs, llm);
  return new OpenFsMwSync(bot, wiki);
}

function makeLlm() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;

  if (anthropicKey) {
    return {
      async complete(system: string, prompt: string, opts?: { maxTokens?: number }): Promise<string> {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
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

  if (openaiKey) {
    return {
      async complete(system: string, prompt: string, opts?: { maxTokens?: number }): Promise<string> {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${openaiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o",
            max_tokens: opts?.maxTokens ?? 4096,
            messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
          }),
        });
        const d = await res.json() as any;
        return d.choices[0].message.content;
      },
    };
  }

  // No-op LLM for non-LLM commands
  return {
    async complete(_s: string, _p: string): Promise<string> {
      throw new Error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY to use LLM commands");
    },
  };
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdLogin() {
  await makeBot();
}

async function cmdGet() {
  const title = args[1];
  if (!title) { console.error(c.red("Usage: get <Title>")); process.exit(1); }
  const bot  = await makeBot();
  const page = await bot.getPage(title);
  if (!page) { console.log(c.red(`Page not found: ${title}`)); return; }
  console.log(c.bold(`\n── ${page.title} (rev ${page.lastRevId}) ──`));
  console.log(page.content);
}

async function cmdSearch() {
  const query = args.slice(1).join(" ");
  if (!query) { console.error(c.red("Usage: search <query>")); process.exit(1); }
  const bot     = await makeBot();
  const results = await bot.search(query, 20);
  console.log(c.bold(`\nSearch: "${query}" — ${results.length} results`));
  results.forEach(t => console.log(`  ${c.blue(t)}`));
}

async function cmdEdit() {
  const title   = args[1];
  const content = args.slice(2).join(" ");
  if (!title || !content) { console.error(c.red("Usage: edit <Title> <content>")); process.exit(1); }
  const bot = await makeBot();
  await bot.editPage(title, content, "CLI edit");
  console.log(c.green(`✓ Edited: ${title}`));
}

async function cmdPull() {
  const bot  = await makeBot();
  const sync = await makeSync(bot);
  if (args[1] === "--all") {
    console.log("Pulling all pages...");
    const r = await sync.pullAll({ verbose: true });
    console.log(c.green(`✓ imported: ${r.imported}, skipped: ${r.skipped}`));
  } else {
    const title = args.slice(1).join(" ");
    if (!title) { console.error(c.red("Usage: pull <Title> | --all")); process.exit(1); }
    await sync.pullPage(title);
    console.log(c.green(`✓ pulled: ${title}`));
  }
}

async function cmdPush() {
  const bot  = await makeBot();
  const sync = await makeSync(bot);
  if (args[1] === "--all") {
    const r = await sync.pushAll({ verbose: true });
    console.log(c.green(`✓ pushed: ${r.pushed}, failed: ${r.failed}`));
  } else {
    const path = args[1];
    if (!path) { console.error(c.red("Usage: push <openfs-path> | --all")); process.exit(1); }
    await sync.pushPage(path);
    console.log(c.green(`✓ pushed: ${path}`));
  }
}

async function cmdPages() {
  const bot  = await makeBot();
  const sync = await makeSync(bot);
  const pages = await (sync as any).wiki.pages();
  console.log(c.bold(`\n${pages.length} wiki pages:`));
  pages.forEach((p: any) => console.log(`  ${c.blue(p.path)} ${c.dim(`(${p.size}b)`)}`));
}

async function cmdStats() {
  const bot  = await makeBot();
  const sync = await makeSync(bot);
  const stats = (sync as any).wiki.agentFs.stats();
  console.log(c.bold("\nOpenFS stats:"));
  console.log(`  Files:  ${stats.fileCount}`);
  console.log(`  Chunks: ${stats.chunkCount}`);
  console.log(`  Size:   ${(stats.totalSize / 1024).toFixed(1)}kb`);

  const mwPages = await bot.getAllPages({ limit: 9999 });
  console.log(`  MW pages: ${mwPages.length}`);
}

async function cmdSyncRecent() {
  const limit = parseInt(args[1] ?? "10");
  const bot   = await makeBot();
  const sync  = await makeSync(bot);
  const synced = await sync.syncRecentChanges(limit);
  console.log(c.green(`✓ synced ${synced.length} recently changed pages`));
  synced.forEach(t => console.log(`  ${c.blue(t)}`));
}

async function cmdQuery() {
  const question = args.slice(1).join(" ");
  if (!question) { console.error(c.red('Usage: query "<question>"')); process.exit(1); }
  const bot  = await makeBot();
  const sync = await makeSync(bot);
  console.log(c.dim(`Querying: "${question}"...`));
  const answer = await sync.query(question, { persist: false, verbose: true });
  console.log(c.bold("\nAnswer:"));
  console.log(answer);
}

async function cmdIngest() {
  const filePath = args[1];
  if (!filePath) { console.error(c.red("Usage: ingest <file> [title]")); process.exit(1); }
  const { readFileSync } = await import("fs");
  const content = readFileSync(filePath, "utf-8");
  const title   = args[2] ?? filePath.split("/").pop()!;

  const bot  = await makeBot();
  const sync = await makeSync(bot);
  console.log(c.dim(`Ingesting "${title}" (${content.length} chars)...`));
  const r = await sync.ingestAndSync(title, content, { verbose: true });
  console.log(c.green(`✓ created: ${r.pagesCreated.length}, updated: ${r.pagesUpdated.length}, pushed: ${r.pushed.length}`));
}

// ── Router ──────────────────────────────────────────────────────────────────

const commands: Record<string, () => Promise<void>> = {
  login:        cmdLogin,
  get:          cmdGet,
  search:       cmdSearch,
  edit:         cmdEdit,
  pull:         cmdPull,
  push:         cmdPush,
  pages:        cmdPages,
  sources:      cmdPages,
  stats:        cmdStats,
  "sync-recent": cmdSyncRecent,
  query:        cmdQuery,
  ingest:       cmdIngest,
};

if (!cmd || cmd === "--help" || cmd === "-h") {
  usage();
  process.exit(0);
}

const fn = commands[cmd];
if (!fn) {
  console.error(c.red(`Unknown command: ${cmd}`));
  usage();
  process.exit(1);
}

fn().catch(e => {
  console.error(c.red(`Error: ${e.message}`));
  process.exit(1);
});
