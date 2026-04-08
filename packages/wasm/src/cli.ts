#!/usr/bin/env node
/**
 * @openfs/wasm CLI
 *
 * Minimal REPL for agents — boots a sandboxed WASM filesystem, accepts
 * shell commands on stdin, prints stdout/stderr to stdout.
 *
 * Usage:
 *   bun run src/cli.ts [--docs <json-file>]
 *
 * Pipe mode (non-interactive):
 *   echo 'grep -r token /docs' | bun run src/cli.ts
 *
 * Inline docs:
 *   bun run src/cli.ts --docs ./my-docs.json
 */

import { createAgentFs } from "./index.js";
import { createInterface } from "readline";
import { readFileSync, existsSync } from "fs";

// ── Parse args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let docsFile: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--docs" && args[i + 1]) docsFile = args[i + 1];
}

// ── Load initial docs ─────────────────────────────────────────────────────────
let docs: Record<string, string> = {};
if (docsFile) {
  if (!existsSync(docsFile)) {
    console.error(`Error: docs file not found: ${docsFile}`);
    process.exit(1);
  }
  try {
    docs = JSON.parse(readFileSync(docsFile, "utf-8"));
    console.error(`Loaded ${Object.keys(docs).length} files from ${docsFile}`);
  } catch {
    console.error(`Error: invalid JSON in ${docsFile}`);
    process.exit(1);
  }
} else {
  // Default demo corpus
  docs = {
    "/docs/auth.md": [
      "# Authentication",
      "",
      "Use Bearer tokens for all API requests.",
      "The access_token expires after 1 hour.",
      "Use the refresh_token to get a new access_token.",
      "",
      "## OAuth2",
      "We support OAuth2 authorization code flow.",
      "Redirect URI must be registered before use.",
    ].join("\n"),
    "/docs/api.md": [
      "# API Reference",
      "",
      "POST /users — create a new user (requires access_token)",
      "GET  /users/:id — get user by ID",
      "DELETE /users/:id — delete user (admin only)",
      "",
      "## Rate limiting",
      "100 requests per minute per access_token.",
    ].join("\n"),
    "/docs/webhooks.md": [
      "# Webhooks",
      "",
      "Use webhook_secret to verify incoming payloads.",
      "HMAC-SHA256 signature in X-Webhook-Signature header.",
      "",
      "## Retry policy",
      "Failed deliveries are retried up to 3 times with exponential backoff.",
    ].join("\n"),
    "/docs/guides/quickstart.md": [
      "# Quickstart",
      "",
      "1. Create an account and get your api_key",
      "2. Exchange api_key for access_token via POST /auth/token",
      "3. Use access_token in Authorization: Bearer <token> header",
      "4. Make your first API call",
    ].join("\n"),
  };
}

// ── Boot ──────────────────────────────────────────────────────────────────────
process.stderr.write("Booting WASM filesystem...");
const fs = await createAgentFs({ docs });
const { fileCount, totalSize } = fs.stats();
process.stderr.write(` ready. ${fileCount} files, ${(totalSize / 1024).toFixed(1)}KB\n`);

// Pre-warm just-bash's lazy-loaded commands. Bun has a quirk where dynamic
// imports triggered inside readline event callbacks may fail; running each
// command once here loads and caches the module before readline starts.
await Promise.all([
  fs.exec("ls /"),
  fs.exec("cat /dev/null 2>/dev/null || true"),
  fs.exec("head -0 /dev/null 2>/dev/null || true"),
  fs.exec("grep '' /dev/null 2>/dev/null || true"),
  fs.exec("find / -maxdepth 0 2>/dev/null || true"),
  fs.exec("stat / 2>/dev/null || true"),
  fs.exec("wc -l /dev/null 2>/dev/null || true"),
]).catch(() => {});  // swallow — these are warmup-only

const isInteractive = process.stdin.isTTY;

if (isInteractive) {
  console.error('OpenFS WASM shell — type "help" for commands, "exit" to quit\n');
}

// ── REPL ──────────────────────────────────────────────────────────────────────
const rl = createInterface({
  input: process.stdin,
  output: isInteractive ? process.stderr : undefined,
  terminal: isInteractive,
  prompt: isInteractive ? "openfs> " : "",
});

if (isInteractive) rl.prompt();

rl.on("line", async (line) => {
  const cmd = line.trim();
  if (!cmd) {
    if (isInteractive) rl.prompt();
    return;
  }

  // Built-in REPL commands
  if (cmd === "exit" || cmd === "quit") {
    await fs.close();
    process.exit(0);
  }

  if (cmd === "help") {
    console.log([
      "",
      "  OpenFS WASM — sandboxed virtual filesystem",
      "",
      "  ── Filesystem ───────────────────────────────────────────────",
      "    ls [path]               List directory",
      "    cat <file>              Read file content",
      "    head [-n N] <file>      First N lines (default 10)",
      "    grep [-r] [-i] <pat> [path]   Search files",
      "    find [path] [-name pat]       Find files",
      "    stat <file>             File metadata",
      "    wc [-l] <file>          Word/line count",
      "",
      "  ── Search ───────────────────────────────────────────────────",
      "    search <query>          Full-text FTS5 search → matching paths",
      "",
      "  ── Management ───────────────────────────────────────────────",
      "    stats                   File count, total size, chunk count",
      "    ingest <path> <content> Add or update a file",
      "    export                  Print DB size (Uint8Array byte count)",
      "",
      "  ── REPL ─────────────────────────────────────────────────────",
      "    help                    Show this message",
      "    exit / quit             Shut down",
      "",
    ].join("\n"));
    if (isInteractive) rl.prompt();
    return;
  }

  if (cmd === "stats") {
    const s = fs.stats();
    console.log(`files: ${s.fileCount}  size: ${(s.totalSize / 1024).toFixed(1)}KB  chunks: ${s.chunkCount}`);
    if (isInteractive) rl.prompt();
    return;
  }

  if (cmd === "export") {
    const snap = fs.export();
    console.log(`DB snapshot: ${snap.byteLength} bytes`);
    if (isInteractive) rl.prompt();
    return;
  }

  if (cmd.startsWith("search ")) {
    const query = cmd.slice(7).trim();
    if (!query) { console.log("Usage: search <query>"); if (isInteractive) rl.prompt(); return; }
    const paths = await fs.search(query);
    if (paths.length === 0) console.log("(no matches)");
    else console.log(paths.join("\n"));
    if (isInteractive) rl.prompt();
    return;
  }

  if (cmd.startsWith("ingest ")) {
    const rest = cmd.slice(7).trim();
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) { console.log("Usage: ingest <path> <content>"); if (isInteractive) rl.prompt(); return; }
    const path    = rest.slice(0, spaceIdx);
    const content = rest.slice(spaceIdx + 1);
    await fs.ingest({ [path]: content });
    const s = fs.stats();
    console.log(`ingested: ${path}  (${s.fileCount} files total)`);
    if (isInteractive) rl.prompt();
    return;
  }

  // All other commands → exec via bash
  try {
    const result = await fs.exec(cmd);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (!isInteractive && result.exitCode !== 0) process.exitCode = result.exitCode;
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
  }

  if (isInteractive) rl.prompt();
});

rl.on("close", async () => {
  await fs.close();
});
