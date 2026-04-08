#!/usr/bin/env bun
/**
 * @openfs/cli — openfs command-line tool
 *
 * Usage:
 *   openfs ls [/wiki]
 *   openfs cat /wiki/page.md
 *   openfs grep <query>
 *   openfs ask "question"
 *   openfs ingest <file|url>
 *   openfs pull
 *   openfs push
 *   openfs map
 *   openfs recent
 *   openfs status
 *   openfs shell        ← interactive REPL
 *
 * Env:
 *   OPENFS_API_URL  — sync server (default http://localhost:4322)
 */

const API = (process.env.OPENFS_API_URL ?? "http://localhost:4322").replace(/\/$/, "");

const CYAN   = "\x1b[36m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const RESET  = "\x1b[0m";

const c = {
  cyan:   (s: string) => CYAN + s + RESET,
  green:  (s: string) => GREEN + s + RESET,
  yellow: (s: string) => YELLOW + s + RESET,
  red:    (s: string) => RED + s + RESET,
  bold:   (s: string) => BOLD + s + RESET,
  dim:    (s: string) => DIM + s + RESET,
};

// ── API helpers ───────────────────────────────────────────────────────────────

async function get(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`);
  return res.json();
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdStatus() {
  const d = await get("/status");
  const icon = d.ok ? c.green("✓") : c.red("✗");
  console.log(`${icon} ${c.bold("OpenFS Sync Server")}  ${c.dim(API)}`);
  console.log(`  Mapped:    ${c.cyan(String(d.synthesizedCount))} pages`);
  console.log(`  Last sync: ${d.lastSync ? new Date(d.lastSync).toLocaleString() : "never"}`);
  console.log(`  Syncing:   ${d.syncRunning ? c.yellow("yes") : "no"}`);
  console.log(`  MW:        ${d.mwUrl}`);
}

async function cmdLs(dir = "/wiki") {
  const entries = await get(`/ls?dir=${encodeURIComponent(dir)}`);
  console.log(c.bold(dir + "/"));
  for (const e of entries) {
    const name = typeof e === "string" ? e : (e.path ?? e);
    const short = name.split("/").pop();
    console.log(`  ${c.cyan("📄")} ${short}`);
  }
}

async function cmdCat(path: string) {
  const d = await get(`/cat?path=${encodeURIComponent(path)}`);
  if (d.error) { console.error(c.red("Error: " + d.error)); process.exit(1); }
  console.log(c.dim(`── ${path} ──`));
  console.log(d.content);
}

async function cmdGrep(query: string, dir = "/wiki") {
  const results = await post("/grep", { query, dir });
  if (!results?.length) { console.log(c.dim("No matches.")); return; }
  console.log(c.bold(`grep "${query}" ${dir}`) + c.dim(`  (${results.length} files)`));
  for (const r of results) {
    console.log(`\n${c.cyan(r.path)}`);
    for (const m of r.matches) {
      const line = m.line.length > 120 ? m.line.slice(0, 117) + "..." : m.line;
      console.log(`  ${c.dim("L" + m.num + ":")} ${line}`);
    }
  }
}

async function cmdAsk(question: string) {
  process.stdout.write(c.dim("Thinking... "));
  const d = await post("/query", { question });
  process.stdout.write("\r" + " ".repeat(15) + "\r");
  console.log(c.bold("Q: " + question));
  console.log();
  console.log(d.answer);
  if (d.citations?.length) {
    console.log();
    console.log(c.dim("Sources: ") + d.citations.map((p: string) =>
      c.cyan(p.replace(/^\/wiki\//, "").replace(/\.md$/, ""))
    ).join(c.dim(" · ")));
  }
}

async function cmdPages() {
  const pages = await get("/pages");
  console.log(c.bold(`Wiki Pages (${pages.length} total)`));
  for (const p of pages) {
    const kb = (p.size / 1024).toFixed(1);
    console.log(`  ${c.cyan("●")} ${p.title.padEnd(40)} ${c.dim(kb + "kb")} ${c.dim(p.path)}`);
  }
}

async function cmdRecent() {
  const changes = await get("/recent-changes?limit=20");
  const typeIcon: Record<string, string> = { human: c.green("✏ "), source: c.cyan("📖"), synthesized: c.yellow("🤖") };
  console.log(c.bold("Recent Changes"));
  for (const ch of changes) {
    const icon = typeIcon[ch.type] ?? "  ";
    const ts = new Date(ch.timestamp).toLocaleTimeString();
    console.log(`  ${icon} ${ch.title.padEnd(35)} ${c.dim(ts + " by " + ch.user)}`);
  }
}

async function cmdMap() {
  const d = await get("/map");
  console.log(c.bold(`Link Map`) + c.dim(`  ${d.summary.linked} linked · ${d.summary.ofsOnly} OFS-only · ${d.summary.mwOnly} MW-only`));
  if (d.linked.length) {
    console.log(c.green("\n✓ Linked"));
    for (const l of d.linked) {
      console.log(`  ${c.cyan(l.openfsPath.padEnd(40))} ↔  ${l.mwTitle}`);
    }
  }
  if (d.ofsOnly.length) {
    console.log(c.yellow("\n⚠ OpenFS only"));
    for (const p of d.ofsOnly) console.log(`  ${c.cyan(p.openfsPath)}`);
  }
}

async function cmdIngest(input: string) {
  let title: string, content: string;
  if (input.startsWith("http")) {
    const res = await fetch(input);
    const text = await res.text();
    content = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 8000);
    title = new URL(input).pathname.split("/").filter(Boolean).pop()
      ?.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()) ?? "Web Page";
  } else {
    // treat as file path
    const { readFileSync } = await import("fs");
    content = readFileSync(input, "utf8");
    title = input.split("/").pop()?.replace(/\.[^.]+$/, "")
      .replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()) ?? "Document";
  }
  process.stdout.write(c.dim(`Ingesting "${title}"... `));
  const d = await post("/ingest", { title, content });
  console.log(c.green("done") + c.dim(`  created:${(d.pagesCreated??[]).length} updated:${(d.pagesUpdated??[]).length}`));
}

async function cmdPull() {
  console.log(c.dim("Queuing pull from MediaWiki..."));
  await post("/pull", {});
  console.log(c.green("✓") + " Pull queued — check status in a moment.");
}

async function cmdPush() {
  process.stdout.write(c.dim("Pushing to MediaWiki... "));
  const d = await post("/push", {});
  console.log(c.green("done") + c.dim(`  pushed:${d.pushed} failed:${d.failed}`));
}

async function cmdLint() {
  process.stdout.write(c.dim("Running lint checks... "));
  const d = await post("/lint", {});
  process.stdout.write("\r" + " ".repeat(30) + "\r");
  if (d.error) { console.error(c.red("Error: " + d.error)); return; }
  const { summary, issues } = d;
  const statusIcon = summary.errors > 0 ? c.red("✗") : summary.warnings > 0 ? c.yellow("⚠") : c.green("✓");
  console.log(`${statusIcon} ${c.bold("Wiki Lint")}  ${c.dim(`${summary.pagesChecked} pages checked`)}`);
  console.log(`  ${c.red(`${summary.errors} errors`)}  ${c.yellow(`${summary.warnings} warnings`)}`);
  if (issues.length === 0) { console.log(c.green("  All checks passed!")); return; }
  console.log();
  for (const issue of issues) {
    const icon = issue.severity === "error" ? c.red("✗") : c.yellow("⚠");
    const rule = c.bold(`[${issue.rule}]`);
    const path = c.cyan(issue.path.replace(/^\/wiki\//, "").replace(/\.md$/, ""));
    console.log(`  ${icon} ${rule} ${path}`);
    console.log(`     ${c.dim(issue.detail)}`);
    console.log(`     ${c.dim("Fix: " + issue.fix)}`);
  }
}

async function cmdSearch(query: string, mode = "hybrid") {
  process.stdout.write(c.dim(`Searching "${query}"... `));
  let results: any[] = [];
  if (mode === "semantic") {
    const d = await post("/kg-search", { query, topK: 8 });
    results = (d.results ?? []).map((r: any) => ({ path: r.source, score: r.score, excerpt: r.content?.slice(0, 120) }));
  } else {
    // hybrid: grep + semantic
    const [grepD, semD] = await Promise.all([
      post("/grep", { query, dir: "/wiki" }),
      post("/kg-search", { query, topK: 6 }),
    ]);
    const seen = new Set<string>();
    for (const r of grepD ?? []) { seen.add(r.path); results.push({ path: r.path, score: null, excerpt: r.matches?.[0]?.line?.slice(0, 120) }); }
    for (const r of semD?.results ?? []) { if (!seen.has(r.source)) results.push({ path: r.source, score: r.score, excerpt: r.content?.slice(0, 120) }); }
  }
  process.stdout.write("\r" + " ".repeat(30) + "\r");
  if (!results.length) { console.log(c.dim("No results.")); return; }
  console.log(c.bold(`Search: "${query}"`) + c.dim(`  ${results.length} results`));
  for (const r of results) {
    const score = r.score != null ? c.cyan(` ${(r.score * 100).toFixed(0)}%`) : c.dim(" grep");
    const name = r.path?.split("/").pop()?.replace(/\.md$/, "") ?? r.path;
    console.log(`\n  ${c.cyan(name)}${score}`);
    if (r.excerpt) console.log(`  ${c.dim(r.excerpt)}`);
  }
}

async function cmdEmbed(target: string, bucket?: string) {
  if (target === "wiki") {
    process.stdout.write(c.dim("Embedding wiki pages into Chroma... "));
    const d = await post("/kg-ingest-wiki", {});
    console.log(c.green("done") + c.dim(`  ${d.pagesEmbedded} pages, ${d.chunksStored} chunks`));
  } else if (target === "s3") {
    if (!bucket) { console.error(c.red("Usage: openfs embed s3 <bucket>")); process.exit(1); }
    process.stdout.write(c.dim(`Embedding s3://${bucket}... `));
    const d = await post("/s3-ingest", { bucket });
    console.log(c.green("done") + c.dim(`  ${d.filesProcessed} files, ${d.chunksStored} chunks, ${d.entitiesExtracted} entities`));
  } else {
    console.error(c.red("Usage: openfs embed wiki | openfs embed s3 <bucket>"));
  }
}

async function cmdExpand(topic: string) {
  process.stdout.write(c.dim(`Expanding topic "${topic}"... `));
  const d = await post("/kg-expand", { topic });
  if (d.error) { console.error(c.red("Error: " + d.error)); return; }
  console.log(c.green("done"));
  console.log(`  Topic:   ${c.cyan(d.topic)}`);
  console.log(`  Sources: ${c.bold(String(d.resultCount))}`);
  if (d.wikiPath) console.log(`  Page:    ${c.cyan(d.wikiPath)}`);
}

async function cmdLog(limit = 20) {
  const d = await get("/log");
  if (d.error) { console.error(c.red("Error: " + d.error)); return; }
  const lines = (d.content as string).split("\n");
  const entries = lines.join("\n").split(/^## /m).filter(Boolean).slice(-limit);
  console.log(c.bold("Activity Log") + c.dim(`  last ${entries.length} entries`));
  for (const entry of entries.reverse()) {
    const [header, ...body] = entry.split("\n");
    const match = header.match(/^\[([^\]]+)\]\s+(\S+)\s*\|\s*(.+)$/);
    if (match) {
      const [, date, op, title] = match;
      const opColor = op === "ingest" ? c.cyan : op === "lint" ? c.yellow : op === "embed" ? c.green : c.dim;
      console.log(`\n  ${c.dim(date)}  ${opColor(op.padEnd(8))}  ${c.bold(title)}`);
      const detail = body.filter(Boolean).join(" ").slice(0, 100);
      if (detail) console.log(`  ${c.dim(detail)}`);
    } else {
      console.log(`\n  ${c.dim(header)}`);
    }
  }
}

// ── Interactive Shell ─────────────────────────────────────────────────────────

async function cmdShell() {
  console.log(c.bold("OpenFS Shell") + c.dim("  " + API));
  console.log(c.dim("Commands: ls, cat, grep, search, ask, pages, recent, map, pull, push, ingest, expand, embed, lint, log, status, exit"));
  console.log();

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const prompt = () => new Promise<string>(resolve => rl.question(c.cyan("openfs> "), resolve));

  while (true) {
    const line = (await prompt()).trim();
    if (!line) continue;
    if (line === "exit" || line === "quit") { rl.close(); break; }

    const [cmd, ...rest] = line.split(" ");
    const arg = rest.join(" ");

    try {
      const [sub, ...subRest] = rest;
      switch (cmd) {
        case "status":  await cmdStatus(); break;
        case "ls":      await cmdLs(arg || "/wiki"); break;
        case "cat":     await cmdCat(arg); break;
        case "grep":    await cmdGrep(arg); break;
        case "search":  await cmdSearch(arg); break;
        case "ask":     await cmdAsk(arg); break;
        case "pages":   await cmdPages(); break;
        case "recent":  await cmdRecent(); break;
        case "map":     await cmdMap(); break;
        case "pull":    await cmdPull(); break;
        case "push":    await cmdPush(); break;
        case "ingest":  await cmdIngest(arg); break;
        case "expand":  await cmdExpand(arg); break;
        case "embed":   await cmdEmbed(sub, subRest[0]); break;
        case "lint":    await cmdLint(); break;
        case "log":     await cmdLog(); break;
        default:
          console.log(c.dim(`Unknown: ${cmd}. Try: ls, cat, grep, search, ask, pages, recent, map, pull, push, ingest, expand, embed, lint, log, status`));
      }
    } catch (e) {
      console.error(c.red("Error: " + (e as Error).message));
    }
    console.log();
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

const HELP = `
${c.bold("openfs")} — AI knowledge filesystem CLI  ${c.dim(API)}

${c.bold("Usage:")}
  openfs status              server health + sync info
  openfs ls [dir]            list wiki pages
  openfs cat <path>          read a page
  openfs grep <query>        full-text search
  openfs search <query>      hybrid grep + semantic search
  openfs ask <question>      AI query with citations
  openfs pages               list all pages with sizes
  openfs recent              recent wiki changes
  openfs map                 OpenFS ↔ MediaWiki link map
  openfs pull                pull all MW pages
  openfs push                push OpenFS pages to MW
  openfs ingest <file|url>   add document to knowledge base
  openfs expand <topic>      expand topic into wiki page
  openfs embed wiki          embed all wiki pages into Chroma
  openfs embed s3 <bucket>   run S3 pipeline on a bucket
  openfs lint                run wiki health checks (L1-L10)
  openfs log                 show activity log
  openfs shell               interactive REPL

${c.bold("Env:")}
  OPENFS_API_URL             sync server (default http://localhost:4322)
`;

try {
  switch (cmd) {
    case "status":  await cmdStatus(); break;
    case "ls":      await cmdLs(args[0]); break;
    case "cat":     if (!args[0]) { console.error("Usage: openfs cat <path>"); process.exit(1); } await cmdCat(args[0]); break;
    case "grep":    if (!args[0]) { console.error("Usage: openfs grep <query>"); process.exit(1); } await cmdGrep(args.join(" ")); break;
    case "search":  if (!args[0]) { console.error("Usage: openfs search <query>"); process.exit(1); } await cmdSearch(args.join(" ")); break;
    case "ask":     if (!args[0]) { console.error("Usage: openfs ask <question>"); process.exit(1); } await cmdAsk(args.join(" ")); break;
    case "pages":   await cmdPages(); break;
    case "recent":  await cmdRecent(); break;
    case "map":     await cmdMap(); break;
    case "pull":    await cmdPull(); break;
    case "push":    await cmdPush(); break;
    case "ingest":  if (!args[0]) { console.error("Usage: openfs ingest <file|url>"); process.exit(1); } await cmdIngest(args[0]); break;
    case "expand":  if (!args[0]) { console.error("Usage: openfs expand <topic>"); process.exit(1); } await cmdExpand(args.join(" ")); break;
    case "embed":   await cmdEmbed(args[0], args[1]); break;
    case "lint":    await cmdLint(); break;
    case "log":     await cmdLog(parseInt(args[0] ?? "20")); break;
    case "shell":   await cmdShell(); break;
    default:        console.log(HELP);
  }
} catch (e) {
  console.error(c.red("Error: " + (e as Error).message));
  process.exit(1);
}
