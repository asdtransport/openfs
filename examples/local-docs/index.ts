/**
 * OpenFS Example: Local Documentation
 *
 * The simplest possible OpenFS setup:
 *   1. Index a folder of markdown files into SQLite
 *   2. Give an AI agent a virtual filesystem backed by that DB
 *   3. Run shell commands against the virtual docs
 *
 * Usage:
 *   bun run examples/local-docs/index.ts
 */

import { Bash } from "just-bash";
import { PathTree } from "../../packages/core/src/path-tree";
import { createOpenFs } from "../../packages/core/src/openfs";
import { SqliteAdapter } from "../../packages/adapter-sqlite/src/sqlite-adapter";

// --- Sample docs (in production, use the Python indexer) ---
const docs: Record<string, string> = {
  "/docs/README.md": "# My Project\n\nWelcome to the project documentation.\n",
  "/docs/auth/login.md": "# Login\n\nPOST /auth/login with email and password.\nReturns an access_token.\n",
  "/docs/auth/logout.md": "# Logout\n\nPOST /auth/logout to invalidate the access_token.\n",
  "/docs/api/users.md": "# Users\n\nGET /users — list all users (requires access_token).\nGET /users/:id — get a single user.\n",
  "/docs/api/billing.md": "# Billing\n\nGET /billing/invoices — list invoices.\nPOST /billing/charge — create a charge.\n",
};

async function main() {
  console.log("🗂️  OpenFS Local Docs Example\n");

  // 1. Create adapter and ingest
  const adapter = new SqliteAdapter({ dbPath: ":memory:" });
  adapter.ingestDirectory(docs);
  console.log(`Indexed ${Object.keys(docs).length} files into SQLite (in-memory)`);

  // 2. Initialize and build path tree
  const pathMap = await adapter.init();
  const tree = new PathTree();
  tree.build(pathMap);
  console.log(`Path tree: ${tree.fileCount} files, ${tree.dirCount} directories\n`);

  // 3. Create filesystem and bash
  const fs = createOpenFs(adapter, { pathTree: tree });
  const bash = new Bash({ fs, cwd: "/" });

  // 4. Run commands!
  const commands = [
    "ls /docs",
    "ls /docs/auth",
    "cat /docs/README.md",
    "cat /docs/auth/login.md | grep access_token",
    "cat /docs/api/users.md | wc -l",
    "head -3 /docs/api/billing.md",
  ];

  for (const cmd of commands) {
    console.log(`$ ${cmd}`);
    const result = await bash.exec(cmd);
    if (result.exitCode === 0) {
      console.log(result.stdout);
    } else {
      console.log(`[exit ${result.exitCode}] ${result.stderr}`);
    }
  }

  // 5. Show FTS5 search
  console.log("--- FTS5 Search: 'access_token' ---");
  const results = await adapter.search("access_token");
  for (const r of results) {
    console.log(`  ${r.path}`);
  }

  await adapter.close();
  console.log("\n✅ Done");
}

main();
