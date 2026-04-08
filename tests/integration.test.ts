/**
 * OpenFS Integration Test
 *
 * Tests the full pipeline:
 *   1. Create SQLite adapter with bun:sqlite
 *   2. Ingest sample documentation files
 *   3. Initialize the adapter → build PathTree
 *   4. Wrap with createOpenFs → IFileSystem
 *   5. Pass to just-bash as fs option
 *   6. Run real shell commands: ls, cat, grep, find
 *   7. Verify results
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Bash } from "just-bash";
import { PathTree } from "../packages/core/src/path-tree";
import { InMemoryCache } from "../packages/core/src/cache";
import { createOpenFs } from "../packages/core/src/openfs";
import { SqliteAdapter } from "../packages/adapter-sqlite/src/sqlite-adapter";
import { parseGrepFlags, rewriteGrepCommand } from "../packages/grep-optimizer/src/grep-optimizer";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/openfs-test.db";

// Sample documentation files
const SAMPLE_DOCS: Record<string, string> = {
  "/docs/getting-started.mdx": `# Getting Started

Welcome to our API. To authenticate, you'll need an access_token.

## Installation

\`\`\`bash
npm install our-sdk
\`\`\`

## Quick Start

Use your access_token in the Authorization header:

\`\`\`
Authorization: Bearer <your_access_token>
\`\`\`
`,
  "/docs/auth/oauth.mdx": `# OAuth 2.0

Our API uses OAuth 2.0 for authentication.

## Getting an access_token

1. Register your application
2. Redirect users to the authorization URL
3. Exchange the code for an access_token
4. Use the access_token in API requests

## Refresh Tokens

When your access_token expires, use the refresh_token to get a new one.
`,
  "/docs/auth/api-keys.mdx": `# API Keys

API keys are an alternative to OAuth for server-to-server communication.

## Creating an API Key

Navigate to Settings → API Keys and click "Create New Key".

## Usage

Include the key in the X-API-Key header:

\`\`\`
X-API-Key: your_api_key_here
\`\`\`
`,
  "/docs/api/users.mdx": `# Users API

## GET /users

Returns a list of users. Requires access_token in the Authorization header.

### Parameters

- limit: Maximum number of results (default: 20)
- offset: Pagination offset

### Response

\`\`\`json
{
  "users": [{"id": 1, "name": "Alice"}],
  "total": 100
}
\`\`\`
`,
  "/docs/api/webhooks.mdx": `# Webhooks

Configure webhooks to receive real-time notifications.

## Setup

1. Navigate to Settings → Webhooks
2. Add your endpoint URL
3. Select events to subscribe to

## Webhook Payload

Each webhook includes a signature in the X-Webhook-Signature header.
Verify the signature using your webhook_secret.

## Events

- user.created
- user.updated
- invoice.paid
- subscription.cancelled
`,
  "/docs/guides/quickstart.mdx": `# Quick Start Guide

Get started by generating an access_token using the OAuth guide.

## Step 1: Create an Application

Go to the developer portal and register a new application.

## Step 2: Authenticate

Follow the OAuth 2.0 flow to get your access_token.

## Step 3: Make Your First Request

\`\`\`bash
curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \\
  https://api.example.com/users
\`\`\`
`,
};

describe("SQLite Adapter", () => {
  let adapter: SqliteAdapter;

  beforeAll(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    adapter = new SqliteAdapter({ dbPath: TEST_DB });
    adapter.ingestDirectory(SAMPLE_DOCS);
  });

  afterAll(async () => {
    await adapter.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    // Clean WAL/SHM files
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(TEST_DB + ext)) unlinkSync(TEST_DB + ext);
    }
  });

  test("init returns path tree with all files", async () => {
    const pathMap = await adapter.init();
    expect(pathMap.size).toBe(6);
    expect(pathMap.has("/docs/getting-started.mdx")).toBe(true);
    expect(pathMap.has("/docs/auth/oauth.mdx")).toBe(true);
    expect(pathMap.has("/docs/api/webhooks.mdx")).toBe(true);
  });

  test("readFile returns full content", async () => {
    const content = await adapter.readFile("/docs/auth/oauth.mdx");
    expect(content).toContain("OAuth 2.0");
    expect(content).toContain("access_token");
    expect(content).toContain("refresh_token");
  });

  test("readFile throws ENOENT for missing file", async () => {
    expect(adapter.readFile("/docs/nonexistent.mdx")).rejects.toThrow("ENOENT");
  });

  test("getFileMeta returns correct metadata", async () => {
    const meta = await adapter.getFileMeta("/docs/auth/oauth.mdx");
    expect(meta.path).toBe("/docs/auth/oauth.mdx");
    expect(meta.size).toBeGreaterThan(0);
    expect(meta.chunkCount).toBe(1);
  });

  test("search finds files with FTS5", async () => {
    const results = await adapter.search("access_token");
    expect(results.length).toBeGreaterThanOrEqual(3);
    const paths = results.map((r) => r.path);
    expect(paths).toContain("/docs/getting-started.mdx");
    expect(paths).toContain("/docs/auth/oauth.mdx");
    expect(paths).toContain("/docs/api/users.mdx");
  });

  test("search finds webhook-related files", async () => {
    const results = await adapter.search("webhook");
    const paths = results.map((r) => r.path);
    expect(paths).toContain("/docs/api/webhooks.mdx");
  });

  test("bulkPrefetch loads multiple files", async () => {
    const prefetched = await adapter.bulkPrefetch([
      "/docs/auth/oauth.mdx",
      "/docs/auth/api-keys.mdx",
    ]);
    expect(prefetched.size).toBe(2);
    expect(prefetched.get("/docs/auth/oauth.mdx")).toContain("OAuth 2.0");
    expect(prefetched.get("/docs/auth/api-keys.mdx")).toContain("API Keys");
  });

  test("getStats returns correct counts", () => {
    const stats = adapter.getStats();
    expect(stats.fileCount).toBe(6);
    expect(stats.totalSize).toBeGreaterThan(0);
  });
});

describe("PathTree", () => {
  let tree: PathTree;

  beforeAll(async () => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    const adapter = new SqliteAdapter({ dbPath: TEST_DB });
    adapter.ingestDirectory(SAMPLE_DOCS);
    const pathMap = await adapter.init();
    tree = new PathTree();
    tree.build(pathMap);
    await adapter.close();
  });

  afterAll(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(TEST_DB + ext)) unlinkSync(TEST_DB + ext);
    }
  });

  test("root directory exists", () => {
    expect(tree.isDirectory("/")).toBe(true);
  });

  test("readdir lists /docs children", () => {
    const children = tree.readdir("/docs");
    expect(children).toContain("getting-started.mdx");
    expect(children).toContain("auth");
    expect(children).toContain("api");
    expect(children).toContain("guides");
  });

  test("readdir lists /docs/auth children", () => {
    const children = tree.readdir("/docs/auth");
    expect(children).toContain("oauth.mdx");
    expect(children).toContain("api-keys.mdx");
  });

  test("isFile detects files", () => {
    expect(tree.isFile("/docs/auth/oauth.mdx")).toBe(true);
    expect(tree.isFile("/docs/auth")).toBe(false);
  });

  test("isDirectory detects directories", () => {
    expect(tree.isDirectory("/docs/auth")).toBe(true);
    expect(tree.isDirectory("/docs/auth/oauth.mdx")).toBe(false);
  });

  test("getAllPaths returns all files", () => {
    expect(tree.getAllPaths().length).toBe(6);
  });

  test("RBAC pruning works", async () => {
    // Re-ingest with mixed access
    const adapter2 = new SqliteAdapter({ dbPath: "/tmp/openfs-rbac-test.db" });
    adapter2.ingestDirectory(
      { "/public/readme.md": "Public doc", "/internal/secrets.md": "Secret doc" },
      { isPublic: true },
    );
    // Mark internal as private
    // Direct SQL to set is_public = 0 for internal
    // We'll test via the pathMap filter instead
    const pathMap = new Map<string, { isPublic: boolean; groups: string[] }>();
    pathMap.set("/public/readme.md", { isPublic: true, groups: [] });
    pathMap.set("/internal/secrets.md", { isPublic: false, groups: ["admin"] });

    const prunedTree = new PathTree();
    prunedTree.build(pathMap, ["viewer"]); // viewer has no admin access
    expect(prunedTree.isFile("/public/readme.md")).toBe(true);
    expect(prunedTree.exists("/internal/secrets.md")).toBe(false);

    const adminTree = new PathTree();
    adminTree.build(pathMap, ["admin"]);
    expect(adminTree.isFile("/internal/secrets.md")).toBe(true);

    await adapter2.close();
    for (const f of ["/tmp/openfs-rbac-test.db", "/tmp/openfs-rbac-test.db-wal", "/tmp/openfs-rbac-test.db-shm"]) {
      if (existsSync(f)) unlinkSync(f);
    }
  });
});

describe("InMemoryCache", () => {
  test("get/set/del work", async () => {
    const cache = new InMemoryCache(10);
    await cache.set("key1", "value1");
    expect(await cache.get("key1")).toBe("value1");
    await cache.del("key1");
    expect(await cache.get("key1")).toBeNull();
  });

  test("LRU eviction works", async () => {
    const cache = new InMemoryCache(3);
    await cache.set("a", "1");
    await cache.set("b", "2");
    await cache.set("c", "3");
    await cache.set("d", "4"); // should evict "a"
    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("d")).toBe("4");
  });

  test("TTL expiration works", async () => {
    const cache = new InMemoryCache(10);
    await cache.set("expire", "val", 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    expect(await cache.get("expire")).toBeNull();
  });
});

describe("Grep Optimizer", () => {
  test("parseGrepFlags parses -ri", () => {
    const flags = parseGrepFlags(["-ri", "access_token", "/"]);
    expect(flags.recursive).toBe(true);
    expect(flags.ignoreCase).toBe(true);
    expect(flags.pattern).toBe("access_token");
    expect(flags.paths).toEqual(["/"]);
  });

  test("parseGrepFlags parses long flags", () => {
    const flags = parseGrepFlags(["--ignore-case", "--recursive", "webhook", "/docs"]);
    expect(flags.recursive).toBe(true);
    expect(flags.ignoreCase).toBe(true);
    expect(flags.pattern).toBe("webhook");
  });

  test("parseGrepFlags parses -e pattern", () => {
    const flags = parseGrepFlags(["-rie", "test_pattern", "/src"]);
    expect(flags.recursive).toBe(true);
    expect(flags.ignoreCase).toBe(true);
    expect(flags.pattern).toBe("test_pattern");
  });

  test("rewriteGrepCommand narrows to candidate files", () => {
    const rewritten = rewriteGrepCommand(
      ["-ri", "access_token", "/"],
      ["/docs/auth/oauth.mdx", "/docs/api/users.mdx"],
    );
    expect(rewritten).toContain("-i");
    expect(rewritten).not.toContain("-r"); // no recursive needed with explicit files
    expect(rewritten).toContain("/docs/auth/oauth.mdx");
    expect(rewritten).toContain("/docs/api/users.mdx");
  });
});

describe("Full just-bash Integration", () => {
  let bash: Bash;
  let adapter: SqliteAdapter;
  const DB = "/tmp/openfs-justbash-test.db";

  beforeAll(async () => {
    if (existsSync(DB)) unlinkSync(DB);
    adapter = new SqliteAdapter({ dbPath: DB });
    adapter.ingestDirectory(SAMPLE_DOCS);

    const pathMap = await adapter.init();
    const tree = new PathTree();
    tree.build(pathMap);

    const fs = createOpenFs(adapter, { pathTree: tree });
    bash = new Bash({ fs, cwd: "/" });
  });

  afterAll(async () => {
    await adapter.close();
    for (const f of [DB, DB + "-wal", DB + "-shm"]) {
      if (existsSync(f)) unlinkSync(f);
    }
  });

  test("ls / shows docs directory", async () => {
    const result = await bash.exec("ls /");
    expect(result.stdout.trim()).toBe("docs");
    expect(result.exitCode).toBe(0);
  });

  test("ls /docs shows all top-level entries", async () => {
    const result = await bash.exec("ls /docs");
    const entries = result.stdout.trim().split("\n");
    expect(entries).toContain("api");
    expect(entries).toContain("auth");
    expect(entries).toContain("getting-started.mdx");
    expect(entries).toContain("guides");
  });

  test("ls /docs/auth shows auth files", async () => {
    const result = await bash.exec("ls /docs/auth");
    const entries = result.stdout.trim().split("\n");
    expect(entries).toContain("api-keys.mdx");
    expect(entries).toContain("oauth.mdx");
  });

  test("cat reads file content", async () => {
    const result = await bash.exec("cat /docs/auth/oauth.mdx");
    expect(result.stdout).toContain("OAuth 2.0");
    expect(result.stdout).toContain("access_token");
    expect(result.exitCode).toBe(0);
  });

  test("cat on missing file fails", async () => {
    const result = await bash.exec("cat /docs/nope.mdx");
    expect(result.exitCode).not.toBe(0);
  });

  test("cat piped through grep works", async () => {
    const result = await bash.exec("cat /docs/auth/oauth.mdx | grep access_token");
    expect(result.stdout).toContain("access_token");
    expect(result.exitCode).toBe(0);
  });

  test("cat piped through wc -l counts lines", async () => {
    const result = await bash.exec("cat /docs/api/webhooks.mdx | wc -l");
    const lineCount = parseInt(result.stdout.trim(), 10);
    expect(lineCount).toBeGreaterThan(5);
  });

  test("head reads first lines", async () => {
    const result = await bash.exec("head -3 /docs/getting-started.mdx");
    expect(result.stdout).toContain("Getting Started");
    expect(result.exitCode).toBe(0);
  });

  test("stat shows file info", async () => {
    const result = await bash.exec("stat /docs/auth/oauth.mdx");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("oauth.mdx");
  });
});
